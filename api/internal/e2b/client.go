// Package e2b is a thin HTTP client for E2B (https://e2b.dev) cloud
// microVM sandboxes. We use E2B as the backend for our `code.execute`
// tool — the user-facing API surface for arbitrary Python execution
// inside an isolated sandbox.
//
// Design notes
// ============
//
// We deliberately do NOT depend on a third-party SDK. E2B has official
// Python + TypeScript SDKs but no Go SDK; rather than wrap one through
// CGO or run a Python helper service we talk to the REST surface
// directly.
//
// All endpoints are bearer-authenticated with the API key configured
// via E2B_API_KEY (loaded into Config in api/internal/config). Per
// CLAUDE.md Invariant #1, the key MUST live in this layer only — the
// Python daemon never sees it. The daemon talks to E2B exclusively
// through /api/v1/agent/tools/execute.
//
// Real E2B architecture (empirically verified, May 2026)
// =======================================================
//
// E2B splits its API across two surfaces:
//
//  1. **Lifecycle API** at `https://api.e2b.dev`:
//       - POST /sandboxes              create
//       - DELETE /sandboxes/{id}       kill
//       - Auth: `X-API-Key: <key>` (NOT Bearer; the same key sent as
//         Bearer returns 401 "invalid number of segments")
//
//  2. **Per-sandbox URL** at
//     `https://{port}-{sandboxID}-{clientID}.e2b.dev`:
//       - Port 49999 → code-interpreter (Jupyter-like) /execute
//       - Port 49983 → envd (environment daemon) /files
//       - These DO NOT take an API key — auth is by URL knowledge
//         (the clientID acts as a per-sandbox secret).
//
// The clientID is returned at sandbox-create time and is required to
// construct any per-sandbox URL. We persist it on the session row so
// daemon restarts don't lose routing.
//
// Code execution response is NDJSON (newline-delimited JSON), one
// event per line:
//
//   {"type": "number_of_executions", "execution_count": 1}
//   {"type": "stdout", "text": "...", "timestamp": "..."}
//   {"type": "stderr", "text": "...", ...}
//   {"type": "result", "data": {"image/png": "<base64>", "text/plain": "..."}}
//   {"type": "error", "name": "ValueError", "value": "...", "traceback": [...]}
//   {"type": "end_of_execution"}
//
// We accumulate stdout/stderr, collect rich results, and surface the
// first error (if any) as CodeExecuteError.

package e2b

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrSandboxNotFound is returned when an operation references a
// sandbox ID that E2B reports as missing (404). Used by the session
// pool to decide whether to provision a fresh sandbox.
var ErrSandboxNotFound = errors.New("e2b: sandbox not found")

// ErrConfigMissing is returned by NewClient when the API key is empty
// (covers the "feature disabled" case so callers can degrade
// gracefully without checking the config field directly).
var ErrConfigMissing = errors.New("e2b: api key not configured")

// Port constants for the per-sandbox URLs. These are baked into the
// `code-interpreter-v1` template; if E2B ships a new template that
// listens on different ports we'd add a template→ports map here.
const (
	codeInterpreterPort = 49999 // /execute (NDJSON stream)
	envdPort            = 49983 // /files (upload + download)
)

// Default location inside the sandbox for user files. E2B's
// code-interpreter template starts the kernel with this as CWD, so
// `pd.read_csv('data.csv')` resolves against this path. files_in
// from the daemon get uploaded here; the agent's code writes its
// output back here.
const SandboxWorkDir = "/home/user"

// Client is the minimal E2B HTTP client. Safe for concurrent use.
type Client struct {
	httpClient *http.Client
	baseURL    string
	apiKey     string
	// userAgent is sent on every request so E2B's logs/metrics can
	// distinguish our traffic from the SDK clients (helpful when we
	// open support tickets).
	userAgent string
	// hostSuffix is the wildcard domain used for per-sandbox URLs.
	// Production: "e2b.dev". Tests can override to point at a local
	// httptest.Server.
	hostSuffix string
}

// Options is the New constructor argument bag.
type Options struct {
	APIKey     string
	BaseURL    string
	HTTPClient *http.Client
	UserAgent  string
	// HostSuffix overrides the per-sandbox URL host pattern. Empty =
	// "e2b.dev" (production). Tests set this to the host:port of an
	// httptest.Server so per-sandbox URLs route there.
	HostSuffix string
}

// New returns a configured client. Returns ErrConfigMissing when no
// APIKey is provided so callers can route that into a "tool disabled"
// error envelope without panicking.
func New(opts Options) (*Client, error) {
	if strings.TrimSpace(opts.APIKey) == "" {
		return nil, ErrConfigMissing
	}
	baseURL := strings.TrimRight(opts.BaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.e2b.dev"
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 90 * time.Second}
	}
	ua := opts.UserAgent
	if ua == "" {
		ua = "shejane-api/1.0 (+https://shejane.ai)"
	}
	hostSuffix := opts.HostSuffix
	if hostSuffix == "" {
		hostSuffix = "e2b.dev"
	}
	return &Client{
		httpClient: httpClient,
		baseURL:    baseURL,
		apiKey:     opts.APIKey,
		userAgent:  ua,
		hostSuffix: hostSuffix,
	}, nil
}

// sandboxOriginScheme picks https for real E2B, http when hostSuffix
// is a localhost test server.
func (c *Client) sandboxOriginScheme() string {
	if strings.HasPrefix(c.hostSuffix, "127.0.0.1") || strings.HasPrefix(c.hostSuffix, "localhost") {
		return "http"
	}
	return "https"
}

// sandboxOrigin builds the per-sandbox URL prefix
// `{scheme}://{port}-{sandboxID}-{clientID}.{hostSuffix}`.
func (c *Client) sandboxOrigin(port int, sandboxID, clientID string) string {
	return fmt.Sprintf("%s://%d-%s-%s.%s", c.sandboxOriginScheme(), port, sandboxID, clientID, c.hostSuffix)
}

// SandboxInfo is what CreateSandbox returns — the IDs needed to
// reconstruct per-sandbox URLs for later RunCode / Upload / Download.
type SandboxInfo struct {
	SandboxID  string    `json:"sandboxID"`
	ClientID   string    `json:"clientID"`
	TemplateID string    `json:"templateID"`
	StartedAt  time.Time `json:"startedAt"`
}

// CreateSandbox provisions a new microVM via E2B's lifecycle API.
// templateID picks the base image; for code execution use
// "code-interpreter-v1" (preloaded with jupyter + pandas + numpy +
// matplotlib + scikit-learn + pdfplumber + ffmpeg). metadata flows
// into E2B's dashboard so we can correlate sandboxes back to
// (user, conversation) when investigating.
func (c *Client) CreateSandbox(ctx context.Context, templateID string, metadata map[string]string) (SandboxInfo, error) {
	if templateID == "" {
		templateID = "code-interpreter-v1"
	}
	payload := map[string]any{
		"templateID": templateID,
	}
	if len(metadata) > 0 {
		payload["metadata"] = metadata
	}
	var info SandboxInfo
	if err := c.doLifecycle(ctx, http.MethodPost, "/sandboxes", payload, &info); err != nil {
		return SandboxInfo{}, fmt.Errorf("create sandbox: %w", err)
	}
	if info.SandboxID == "" {
		return SandboxInfo{}, fmt.Errorf("create sandbox: e2b returned empty sandbox id")
	}
	if info.ClientID == "" {
		return SandboxInfo{}, fmt.Errorf("create sandbox: e2b returned empty client id")
	}
	if info.StartedAt.IsZero() {
		info.StartedAt = time.Now().UTC()
	}
	return info, nil
}

// KillSandbox terminates a sandbox via the lifecycle API. Idempotent:
// 404 from E2B is treated as a successful kill (the sandbox was
// already gone, which is the desired end state).
func (c *Client) KillSandbox(ctx context.Context, sandboxID string) error {
	path := "/sandboxes/" + sandboxID
	err := c.doLifecycle(ctx, http.MethodDelete, path, nil, nil)
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrSandboxNotFound) {
		return nil
	}
	return fmt.Errorf("kill sandbox: %w", err)
}

// CodeExecuteResult is the synchronous result of one code execution.
// Stdout/Stderr/Error are textual; Results carries any "rich" objects
// (matplotlib figures as PNG, pandas DataFrames as HTML, etc.) the
// Jupyter kernel emitted.
type CodeExecuteResult struct {
	Stdout  string             `json:"stdout"`
	Stderr  string             `json:"stderr"`
	Error   *CodeExecuteError  `json:"error,omitempty"`
	Results []CodeOutputResult `json:"results,omitempty"`
	// ExecutionMs measures wall-clock time spent inside RunCode (from
	// HTTP request start to response end). Used by the gateway to
	// settle credits against per-second pricing.
	ExecutionMs int64 `json:"executionMs"`
}

// CodeExecuteError mirrors the IPython "error" channel: name +
// message + traceback list.
type CodeExecuteError struct {
	Name      string   `json:"name"`
	Value     string   `json:"value"`
	Traceback []string `json:"traceback,omitempty"`
}

// CodeOutputResult is one rich-display payload (e.g. an image, a
// rendered DataFrame). Multiple results can come from one cell.
type CodeOutputResult struct {
	Type string            `json:"type"`
	Data map[string]string `json:"data"`
}

// codeExecuteEvent is one line of the NDJSON stream E2B's
// code-interpreter sends from POST /execute. We collect all events
// then collapse into a single CodeExecuteResult.
//
// E2B's actual shape (verified May 2026) puts rich-display payloads
// at the TOP LEVEL of the event, NOT nested inside a `data` map as
// IPython's wire format does. So a matplotlib figure comes back as:
//
//	{"type":"result","text":"<Figure>","png":"<base64>"}
//
// not as `{"type":"result","data":{"image/png":"<base64>","text/plain":"<Figure>"}}`.
// We accept both — `Data` is kept for forward-compat in case E2B ever
// fixes the asymmetry, and we promote top-level Png/Jpeg/Svg/Html
// into the Data map for downstream consumers.
type codeExecuteEvent struct {
	Type      string            `json:"type"`
	Text      string            `json:"text,omitempty"`
	Name      string            `json:"name,omitempty"`
	Value     string            `json:"value,omitempty"`
	Traceback []string          `json:"traceback,omitempty"`
	Data      map[string]string `json:"data,omitempty"`
	// Top-level rich-display fields E2B emits for result/display_data.
	Png      string `json:"png,omitempty"`
	Jpeg     string `json:"jpeg,omitempty"`
	Svg      string `json:"svg,omitempty"`
	Html     string `json:"html,omitempty"`
	Markdown string `json:"markdown,omitempty"`
	Json     any    `json:"json,omitempty"`
	Latex    string `json:"latex,omitempty"`
	Pdf      string `json:"pdf,omitempty"`
}

// RunCode executes a code snippet inside an existing sandbox and
// returns when the kernel reports completion. Uses the per-sandbox
// code-interpreter URL (port 49999) — NOT the lifecycle API. timeout
// caps total wait; language is "python" (only Python supported).
func (c *Client) RunCode(ctx context.Context, sandboxID, clientID, code, language string, timeout time.Duration) (CodeExecuteResult, error) {
	if language == "" {
		language = "python"
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	if sandboxID == "" || clientID == "" {
		return CodeExecuteResult{}, fmt.Errorf("run code: missing sandboxID/clientID")
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	payload, _ := json.Marshal(map[string]any{"code": code, "language": language})
	origin := c.sandboxOrigin(codeInterpreterPort, sandboxID, clientID)
	start := time.Now()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, origin+"/execute", bytes.NewReader(payload))
	if err != nil {
		return CodeExecuteResult{}, fmt.Errorf("run code: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return CodeExecuteResult{ExecutionMs: time.Since(start).Milliseconds()}, fmt.Errorf("run code: transport: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return CodeExecuteResult{ExecutionMs: time.Since(start).Milliseconds()}, ErrSandboxNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		bodyStr := strings.TrimSpace(string(body))
		// E2B's edge proxy returns 502 with a payload like
		//   {"sandboxId":"...","message":"The sandbox was not found","code":502}
		// when the sandbox has been reclaimed/timed out. That's
		// semantically the same as the 404 case above — surface
		// ErrSandboxNotFound so the gateway retries with a fresh
		// sandbox instead of failing the call.
		if resp.StatusCode == http.StatusBadGateway && strings.Contains(strings.ToLower(bodyStr), "sandbox was not found") {
			return CodeExecuteResult{ExecutionMs: time.Since(start).Milliseconds()}, ErrSandboxNotFound
		}
		return CodeExecuteResult{ExecutionMs: time.Since(start).Milliseconds()},
			fmt.Errorf("run code: HTTP %d: %s", resp.StatusCode, bodyStr)
	}
	result := CodeExecuteResult{}
	// Stream is NDJSON. Read line by line; accumulate per-type.
	// The response can be large (e.g. base64 PNGs in result events),
	// so use a Scanner with a generous buffer.
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 64<<20)) // 64 MiB cap
	scanner.Buffer(make([]byte, 0, 1024*1024), 16<<20)             // 16 MiB per token
	var stdoutBuf, stderrBuf strings.Builder
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var ev codeExecuteEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			// Skip malformed lines rather than fail the whole call —
			// E2B occasionally emits a non-JSON heartbeat.
			continue
		}
		switch ev.Type {
		case "stdout":
			stdoutBuf.WriteString(ev.Text)
		case "stderr":
			stderrBuf.WriteString(ev.Text)
		case "error":
			// First error wins. The Jupyter kernel only emits one
			// per execution but be defensive.
			if result.Error == nil {
				result.Error = &CodeExecuteError{
					Name:      ev.Name,
					Value:     ev.Value,
					Traceback: ev.Traceback,
				}
			}
		case "result", "display_data", "execute_result":
			// Merge top-level rich-display fields into a normalized
			// MIME-keyed map. E2B emits {"png":"...","text":"..."}
			// for matplotlib figures; downstream consumers (the
			// client renderer) expect {"image/png":"...","text/plain":"..."}
			// since that's the standard IPython display_data shape.
			data := make(map[string]string)
			for k, v := range ev.Data {
				data[k] = v
			}
			if ev.Png != "" {
				data["image/png"] = ev.Png
			}
			if ev.Jpeg != "" {
				data["image/jpeg"] = ev.Jpeg
			}
			if ev.Svg != "" {
				data["image/svg+xml"] = ev.Svg
			}
			if ev.Html != "" {
				data["text/html"] = ev.Html
			}
			if ev.Markdown != "" {
				data["text/markdown"] = ev.Markdown
			}
			if ev.Latex != "" {
				data["text/latex"] = ev.Latex
			}
			if ev.Pdf != "" {
				data["application/pdf"] = ev.Pdf
			}
			if ev.Text != "" {
				data["text/plain"] = ev.Text
			}
			if len(data) > 0 {
				result.Results = append(result.Results, CodeOutputResult{
					Type: ev.Type,
					Data: data,
				})
			}
		case "end_of_execution", "number_of_executions":
			// Lifecycle markers; nothing to accumulate.
		}
	}
	if err := scanner.Err(); err != nil {
		return result, fmt.Errorf("run code: read stream: %w", err)
	}
	result.Stdout = stdoutBuf.String()
	result.Stderr = stderrBuf.String()
	result.ExecutionMs = time.Since(start).Milliseconds()
	return result, nil
}

// SandboxFile describes one file living inside the sandbox at the
// listing moment. Returned by ListSandboxFiles.
type SandboxFile struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Size  int64  `json:"size,omitempty"`
	IsDir bool   `json:"isDir,omitempty"`
}

// UploadSandboxFile writes a file inside the sandbox at the given
// path. data is the raw bytes (NOT base64 — encoding happens here
// only if needed). path SHOULD be absolute inside the sandbox (e.g.
// /home/user/foo.csv). Uses envd port 49983.
func (c *Client) UploadSandboxFile(ctx context.Context, sandboxID, clientID, path string, data []byte) error {
	if path == "" {
		return fmt.Errorf("upload: path required")
	}
	if sandboxID == "" || clientID == "" {
		return fmt.Errorf("upload: missing sandboxID/clientID")
	}
	// envd takes multipart form upload, file part name = "file",
	// destination via ?path= query.
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", "upload.bin")
	if err != nil {
		return fmt.Errorf("upload: form file: %w", err)
	}
	if _, err := part.Write(data); err != nil {
		return fmt.Errorf("upload: write part: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("upload: close writer: %w", err)
	}

	origin := c.sandboxOrigin(envdPort, sandboxID, clientID)
	u := origin + "/files?path=" + url.QueryEscape(path)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, &buf)
	if err != nil {
		return fmt.Errorf("upload: build request: %w", err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("upload: transport: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrSandboxNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		bodyStr := strings.TrimSpace(string(body))
		if resp.StatusCode == http.StatusBadGateway && strings.Contains(strings.ToLower(bodyStr), "sandbox was not found") {
			return ErrSandboxNotFound
		}
		return fmt.Errorf("upload: HTTP %d: %s", resp.StatusCode, bodyStr)
	}
	return nil
}

// ListSandboxFiles enumerates a directory inside the sandbox.
//
// CAVEAT: as of envd 0.5.x, the GET /files endpoint returns FILE
// CONTENTS (not a listing) when path is a file, and a 400 error
// when path is a directory. Until E2B ships a real directory-listing
// endpoint we implement this by running a tiny Python helper inside
// the sandbox via /execute that emits the listing as NDJSON. That's
// slow (one /execute round-trip per list call) but correct.
//
// Callers should expect this to potentially be empty even when the
// directory has files (the agent's code may have failed to write).
func (c *Client) ListSandboxFiles(ctx context.Context, sandboxID, clientID, dirPath string) ([]SandboxFile, error) {
	if dirPath == "" {
		dirPath = SandboxWorkDir
	}
	listCode := fmt.Sprintf(`
import json, os
__dir = %q
if os.path.isdir(__dir):
    for __name in sorted(os.listdir(__dir)):
        __full = os.path.join(__dir, __name)
        try:
            __sz = os.path.getsize(__full)
        except OSError:
            __sz = 0
        print(json.dumps({"name": __name, "path": __full, "size": __sz, "isDir": os.path.isdir(__full)}))
`, dirPath)
	result, err := c.RunCode(ctx, sandboxID, clientID, listCode, "python", 10*time.Second)
	if err != nil {
		return nil, err
	}
	if result.Error != nil {
		// Directory doesn't exist or other Python-level error — treat
		// as empty rather than failing the surrounding call.
		return nil, nil
	}
	out := make([]SandboxFile, 0)
	for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var f SandboxFile
		if err := json.Unmarshal([]byte(line), &f); err != nil {
			continue
		}
		if !f.IsDir {
			out = append(out, f)
		}
	}
	return out, nil
}

// DownloadSandboxFile reads a file's contents out of the sandbox via
// envd port 49983. Returns the raw bytes (NOT base64).
func (c *Client) DownloadSandboxFile(ctx context.Context, sandboxID, clientID, path string) ([]byte, error) {
	if sandboxID == "" || clientID == "" {
		return nil, fmt.Errorf("download: missing sandboxID/clientID")
	}
	origin := c.sandboxOrigin(envdPort, sandboxID, clientID)
	u := origin + "/files?path=" + url.QueryEscape(path)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("download: build request: %w", err)
	}
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download: transport: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrSandboxNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		bodyStr := strings.TrimSpace(string(body))
		if resp.StatusCode == http.StatusBadGateway && strings.Contains(strings.ToLower(bodyStr), "sandbox was not found") {
			return nil, ErrSandboxNotFound
		}
		return nil, fmt.Errorf("download: HTTP %d: %s", resp.StatusCode, bodyStr)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20)) // 64 MiB cap
}

// doLifecycle is the lifecycle-API (api.e2b.dev) helper.
// body is JSON-marshaled (nil = no body); out is JSON-unmarshaled if
// non-nil. 404 from E2B becomes ErrSandboxNotFound. Authentication
// is via `X-API-Key` header (Bearer returns 401 — E2B uses X-API-Key
// for legacy `e2b_...` API keys).
func (c *Client) doLifecycle(ctx context.Context, method, path string, body any, out any) error {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	// E2B authenticates legacy API keys (the `e2b_…` prefix format)
	// via the `X-API-Key` header. Bearer-token authentication is
	// reserved for OAuth flows we don't use. Verified empirically:
	// the same key returns 401 "invalid number of segments" when sent
	// as Bearer and 201 Created when sent as X-API-Key.
	req.Header.Set("X-API-Key", c.apiKey)
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("transport: %w", err)
	}
	defer resp.Body.Close()
	respBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if readErr != nil {
		return fmt.Errorf("read response: %w", readErr)
	}
	if resp.StatusCode == http.StatusNotFound {
		return ErrSandboxNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(string(respBytes))
		if len(message) > 500 {
			message = message[:500] + "..."
		}
		return fmt.Errorf("e2b HTTP %d: %s", resp.StatusCode, message)
	}
	if out == nil || len(respBytes) == 0 {
		return nil
	}
	if err := json.Unmarshal(respBytes, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}
