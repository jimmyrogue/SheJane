// code.execute tool gateway — billing-aware proxy from the Python
// daemon to the E2B microVM session pool. Lives next to
// tool_gateway.go so it can share the agentToolExecuteResult /
// toolError / positiveCredits helpers. The handler dispatch is in
// tool_gateway.go (agentToolExecute -> codeExecToolName branch).
//
// Lifecycle of one call
// =====================
//
//	1. Daemon sends {tool: "code.execute", arguments: {code,
//	   conversation_id, language?}, tool_call_id, run_id}.
//	2. Idempotency check: same tool_call_id → return cached result.
//	3. Reserve credits = base + (timeout_seconds * per_second). This
//	   over-reserves on the upside so we never panic-release for under-
//	   budget reservations; the actual settle uses true elapsed seconds.
//	4. Insert external_tool_call_records row with status='running'.
//	5. SessionManager.RunCode — find-or-provision sandbox, send code,
//	   wait for result (capped at E2BSandboxRequestTimeoutSeconds).
//	6. Settle credits with actual cost = base + (ceil(execMs/1000) *
//	   per_second). If settle fails, release + mark record failed.
//	7. Finish the tool-call record with the encoded result data.
//
// Stage 5 errors get a tool-result envelope back to the daemon
// (`ok: false, errorCode: "..."`) plus a release on the reservation.
// The daemon turns that into a tool-result message the LLM sees, so
// the agent can decide to retry or fall back.

package httpapi

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/coldflame/shejane/api/internal/billing"
	"github.com/coldflame/shejane/api/internal/e2b"
	"github.com/coldflame/shejane/api/internal/store"
)

// Local base64 helpers — mirror the unexported helpers in
// internal/e2b/client.go. We keep our own copies so the httpapi
// package doesn't need to depend on internal symbols of the e2b
// package.
func base64Encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

func base64Decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// codeExecToolName is the LLM-facing tool name. The daemon's
// @tool("code.execute") in local-host/python/local_host/tools/code.py
// uses the matching string so the agentToolExecute dispatcher routes
// correctly.
const codeExecToolName = "code.execute"

type codeExecInput struct {
	RunID          string
	ToolCallID     string
	IdempotencyKey string
	ConversationID string
	Code           string
	Language       string
	// FilesIn are workspace-resident files to upload into the
	// sandbox before executing. Each {path, content_b64} pair lands at
	// /workspace/<path> in the sandbox (sandbox's CWD is /workspace
	// so the agent can `pd.read_csv('foo.csv')` without absolute
	// paths). Pre-blacklisted by the daemon — Go side only enforces
	// a total-size cap (defense in depth, see codeExecFilesMaxBytes).
	FilesIn []codeExecFileIn
}

type codeExecFileIn struct {
	// Path is workspace-relative (e.g. "sales.xlsx" or "data/q4.csv").
	// MUST not contain ../ — Go side double-checks even though daemon
	// already filtered.
	Path       string `json:"path"`
	ContentB64 string `json:"content_b64"`
}

// codeExecFileOut is one file the sandbox emitted to /output/ that
// we packaged back to the daemon. Path is sandbox-side
// (e.g. "/output/chart.png"); the daemon strips /output/ and writes
// to workspace/.code-output/<conv_id>/<basename>.
type codeExecFileOut struct {
	Path       string `json:"path"`
	ContentB64 string `json:"content_b64"`
	Size       int64  `json:"size"`
}

// codeExecFilesMaxBytes caps the total upload payload per call so a
// runaway daemon (or compromised one) can't blow our memory or the
// E2B sandbox storage. 200 MB matches the per-call budget mentioned
// in the design doc.
const codeExecFilesMaxBytes = 200 * 1024 * 1024

// codeExecOutputMaxBytes caps total bytes downloaded from /output/
// per call. Big enough for several charts + a small dataset, small
// enough that one malicious code run can't fill the user's disk.
const codeExecOutputMaxBytes = 50 * 1024 * 1024

// codeExecMaxFilesPerCall caps how many files we'll move in either
// direction per call. Prevents a 5000-file mass-rename script from
// stalling the gateway.
const codeExecMaxFilesPerCall = 32

// codeExecData is the JSON payload returned in agentToolExecuteResult.Data
// for code.execute. The daemon parses this into the tool-message text
// the LLM consumes, AND into the rich preview the client renders. The
// shape is also reflected in the pydantic CodeExecuteResult model
// (api_schemas.py) — keep them in sync.
type codeExecData struct {
	Source      string            `json:"source"`
	SandboxID   string            `json:"sandbox_id,omitempty"`
	SessionID   string            `json:"session_id,omitempty"`
	Stdout      string            `json:"stdout"`
	Stderr      string            `json:"stderr"`
	ErrorName   string            `json:"error_name,omitempty"`
	ErrorValue  string            `json:"error_value,omitempty"`
	Traceback   []string          `json:"traceback,omitempty"`
	Results     []codeExecResult  `json:"results,omitempty"`
	FilesOut    []codeExecFileOut `json:"files_out,omitempty"`
	ExecutionMs int64             `json:"execution_ms"`
}

type codeExecResult struct {
	Type string            `json:"type"`
	Data map[string]string `json:"data"`
}

func (s *Server) runCodeExecute(ctx context.Context, user store.User, input codeExecInput) (agentToolExecuteResult, int) {
	if !s.app.IsCodeExecEnabled() {
		return toolError("code_exec_disabled", "code.execute is disabled because E2B is not configured in the cloud API."), http.StatusBadRequest
	}
	if strings.TrimSpace(input.Code) == "" {
		return toolError("code_required", "code argument is required and must be non-empty."), http.StatusBadRequest
	}
	if strings.TrimSpace(input.ConversationID) == "" {
		return toolError("conversation_required", "conversation_id argument is required so the sandbox can be reused across calls."), http.StatusBadRequest
	}
	language := strings.TrimSpace(input.Language)
	if language == "" {
		language = "python"
	}
	if language != "python" {
		return toolError("unsupported_language", "only python is supported in this phase."), http.StatusBadRequest
	}
	if len(input.FilesIn) > codeExecMaxFilesPerCall {
		return toolError("too_many_files", fmt.Sprintf("at most %d files per call (got %d)", codeExecMaxFilesPerCall, len(input.FilesIn))), http.StatusBadRequest
	}
	// Decode + validate every file before reserving credits — bad
	// payload should not consume billing budget.
	decodedFiles, decodeErr := decodeCodeExecFiles(input.FilesIn)
	if decodeErr != nil {
		return toolError("invalid_files_in", decodeErr.Error()), http.StatusBadRequest
	}

	idempotencyKey := strings.TrimSpace(input.IdempotencyKey)
	if idempotencyKey == "" {
		idempotencyKey = strings.Join([]string{input.RunID, input.ToolCallID, codeExecToolName}, ":")
	}

	// Idempotency: if the agent retries the same tool_call_id (e.g.
	// after a transport hiccup) return the cached result — regardless
	// of whether the prior call succeeded or failed. Re-running a
	// failed call on the same idempotency key would multi-charge,
	// because Reserve is unconditional. Callers that genuinely want
	// to retry a transient failure must use a NEW tool_call_id.
	if existing, err := s.app.Store.ExternalToolCallByIdempotencyKey(ctx, user.ID, idempotencyKey); err == nil {
		switch existing.Status {
		case "done":
			return resultFromToolRecord(existing), http.StatusOK
		case "failed":
			// Preserve the original error envelope so the agent sees
			// the same failure and doesn't think the retry "worked".
			return resultFromToolRecord(existing), http.StatusBadGateway
		case "running":
			// Concurrent dup or stuck call. Tell the caller it's in
			// progress; don't reserve or kick a second run.
			return toolError("tool_call_in_progress", "This tool call idempotency key is already being processed."), http.StatusConflict
		}
	}

	// Worst-case reservation: base + timeout × per_second. Real cost
	// settles at end; over-reserve simply releases the difference.
	timeoutSeconds := s.app.Config.E2BSandboxRequestTimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 60
	}
	// Read both levers ONCE here so the reservation ceiling (below) and the
	// settle (actualCredits, further down) use the same value even if an admin
	// edits billing.levers mid-request — reserve and settle can never split.
	baseCredits := positiveCredits(s.app.Registry.E2BCodeExecBaseCredits())
	perSecondCredits := s.app.Registry.E2BCodeExecPerSecondCredits()
	if perSecondCredits < 0 {
		perSecondCredits = 0
	}
	worstCaseCredits := baseCredits + int64(timeoutSeconds)*perSecondCredits

	requestID := requestIDFromContext(ctx, s.app.NewRequestID())
	reservation, err := s.app.Store.ReserveUsage(ctx, user.ID, s.app.Config.MonthlyCredits, worstCaseCredits, billing.ReservationMeta{
		UserID:    user.ID,
		RequestID: requestID,
		Mode:      "tool",
	})
	if err != nil {
		if billing.IsInsufficientCredits(err) {
			return toolError("insufficient_credits", "额度不足，请升级或充值"), http.StatusPaymentRequired
		}
		return toolError("reservation_failed", fmt.Sprintf("额度预留失败: %v", err)), http.StatusInternalServerError
	}

	record, created, err := s.app.Store.CreateExternalToolCall(ctx, store.ExternalToolCallRecord{
		RequestID:      requestID,
		UserID:         user.ID,
		WalletID:       reservation.WalletID,
		ReservationID:  reservation.ID,
		RunID:          input.RunID,
		ToolCallID:     input.ToolCallID,
		Tool:           codeExecToolName,
		Provider:       "e2b",
		Status:         "running",
		IdempotencyKey: idempotencyKey,
		StartedAt:      time.Now().UTC(),
	})
	if err != nil {
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		return toolError("record_failed", fmt.Sprintf("记录工具调用失败: %v", err)), http.StatusInternalServerError
	}
	if !created {
		// Concurrent dup race: a parallel call beat us to the
		// CreateExternalToolCall insert. Release this reservation,
		// then return whatever the prior call resolved to.
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		switch record.Status {
		case "done":
			return resultFromToolRecord(record), http.StatusOK
		case "failed":
			return resultFromToolRecord(record), http.StatusBadGateway
		default:
			return toolError("tool_call_in_progress", "This tool call idempotency key is already being processed."), http.StatusConflict
		}
	}

	// Provision-or-reuse the conversation's sandbox, upload files, run
	// the code. The runWithSandbox helper retries once on
	// ErrSandboxNotFound — *with* re-upload of files_in to the fresh
	// sandbox, so the agent never sees a "ran against an empty
	// /workspace" failure that the prior version of this code would
	// silently produce.
	result, sessionRec, runErr := s.runCodeWithSandbox(ctx, user.ID, input.ConversationID, input.Code, language, decodedFiles)
	if runErr != nil {
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		errorCode, status := classifyRunCodeError(runErr)
		errorMsg := truncateProviderError(runErr.Error())
		errorEnvelope := toolError(errorCode, fmt.Sprintf("code.execute failed: %s", errorMsg))
		_ = s.app.Store.FinishExternalToolCall(ctx, requestID, "failed", 0, 0, errorCode, errorMsg, errorEnvelope.Content, errorEnvelope.Data)
		return errorEnvelope, status
	}

	// Sync /home/user/output/ back. Failure here is non-fatal — we still
	// return the code's stdout/stderr to the agent (which may already
	// contain the agent's answer); the user just won't see the
	// generated file. A warning shows up in stderr so the LLM can
	// flag it. We list ONLY /home/user/output/ (a subdirectory the
	// agent is told to write to in the tool docstring) rather than
	// the full /home/user/ — otherwise we'd round-trip the files_in
	// we just uploaded.
	filesOut, syncErr := s.downloadCodeExecOutput(ctx, sessionRec)
	if syncErr != nil {
		// Tack a notice onto stderr so the LLM and renderer both see it.
		notice := fmt.Sprintf("\n(warning: /output/ sync failed: %s)", truncateProviderError(syncErr.Error()))
		result.Stderr += notice
	}

	// Settle with the real wall-clock seconds. ceil — not floor —
	// because a 1.4s run uses 2 seconds of E2B compute on their
	// metering, and we don't want to underbill systematically.
	actualSeconds := int(math.Ceil(float64(result.ExecutionMs) / 1000.0))
	if actualSeconds < 1 {
		actualSeconds = 1
	}
	actualCredits := baseCredits + int64(actualSeconds)*perSecondCredits

	if err := s.app.Store.SettleUsage(ctx, user.ID, reservation.ID, actualCredits); err != nil {
		// CRITICAL: settle failed — the reservation is still
		// "reserved" status, holding credits hostage. Release it
		// explicitly so the wallet returns to a sane state. Record
		// the real result content (stdout/stderr/files_out) on the
		// failed call row so admin auditing can reproduce what
		// happened to the user.
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		data := buildCodeExecData(result, sessionRec)
		data.FilesOut = filesOut
		content := formatCodeExecContent(result, filesOut)
		_ = s.app.Store.FinishExternalToolCall(ctx, requestID, "failed", actualSeconds, 0, "settlement_failed", err.Error(), content, mustMap(data))
		if billing.IsInsufficientCredits(err) {
			return toolError("insufficient_credits", "额度不足，请升级或充值"), http.StatusPaymentRequired
		}
		return toolError("settlement_failed", fmt.Sprintf("额度结算失败: %v", err)), http.StatusInternalServerError
	}

	data := buildCodeExecData(result, sessionRec)
	data.FilesOut = filesOut
	content := formatCodeExecContent(result, filesOut)

	envelope := agentToolExecuteResult{
		OK:      true,
		Content: content,
		Data:    mustMap(data),
		Usage: map[string]any{
			"credits_cost":          actualCredits,
			"units":                 actualSeconds,
			"request_id":            requestID,
			"sandbox_id":            sessionRec.E2BSandboxID,
			"execution_ms":          result.ExecutionMs,
			"session_total_seconds": sessionRec.TotalSeconds + actualSeconds,
		},
	}
	if err := s.app.Store.FinishExternalToolCall(ctx, requestID, "done", actualSeconds, actualCredits, "", "", content, envelope.Data); err != nil {
		// Result is back; this is just record-keeping. Surface a 500
		// so an admin notices, but the agent already has its answer.
		return envelope, http.StatusInternalServerError
	}
	return envelope, http.StatusOK
}

func buildCodeExecData(result e2b.CodeExecuteResult, rec store.SandboxSessionRecord) codeExecData {
	out := codeExecData{
		Source:      codeExecToolName,
		SandboxID:   rec.E2BSandboxID,
		SessionID:   rec.ID,
		Stdout:      result.Stdout,
		Stderr:      result.Stderr,
		ExecutionMs: result.ExecutionMs,
	}
	if result.Error != nil {
		out.ErrorName = result.Error.Name
		out.ErrorValue = result.Error.Value
		out.Traceback = result.Error.Traceback
	}
	if len(result.Results) > 0 {
		out.Results = make([]codeExecResult, 0, len(result.Results))
		for _, r := range result.Results {
			out.Results = append(out.Results, codeExecResult{Type: r.Type, Data: r.Data})
		}
	}
	return out
}

// formatCodeExecContent renders the LLM-facing text of one code call.
// We keep it concise — stdout first (capped), stderr second (capped),
// then any error name/value/traceback last, then a one-line summary
// of files synced from /output/. The full payload is in Data,
// accessible to the client renderer.
//
// When the kernel emitted rich images (matplotlib figures), we
// PREPEND a control line that explicitly tells the LLM the user has
// already seen the images inline and SHOULD NOT generate markdown
// image links. Without this, models reliably hallucinate fake
// `![](https://imgbb.com/...)` URLs in their final response — the
// model knows there's a chart but doesn't know how the user will see
// it, so it invents a placeholder URL that 404s.
func formatCodeExecContent(result e2b.CodeExecuteResult, filesOut []codeExecFileOut) string {
	parts := make([]string, 0, 6)

	imageCount := 0
	for _, r := range result.Results {
		if _, ok := r.Data["image/png"]; ok {
			imageCount++
			continue
		}
		if _, ok := r.Data["image/jpeg"]; ok {
			imageCount++
			continue
		}
		if _, ok := r.Data["image/svg+xml"]; ok {
			imageCount++
		}
	}
	if imageCount > 0 {
		// Single English line — LLMs follow concrete English
		// instructions about UI behavior more reliably than
		// natural-language Chinese guidance here.
		parts = append(parts, fmt.Sprintf(
			"[IMAGES_RENDERED count=%d] The user already sees these %d chart(s) inline above your reply — DO NOT include any markdown image links (no `![](url)`, no `<img>` tags, no imgbb / picsum / example.com URLs). Describe the chart in your text response.",
			imageCount, imageCount,
		))
	}

	if stdout := strings.TrimRight(result.Stdout, "\n"); stdout != "" {
		parts = append(parts, "stdout:\n"+truncateRunes(stdout, 4000))
	}
	if stderr := strings.TrimRight(result.Stderr, "\n"); stderr != "" {
		parts = append(parts, "stderr:\n"+truncateRunes(stderr, 4000))
	}
	if result.Error != nil {
		errPart := fmt.Sprintf("%s: %s", result.Error.Name, result.Error.Value)
		if len(result.Error.Traceback) > 0 {
			// Join last 5 traceback frames — full thing is huge.
			tb := result.Error.Traceback
			if len(tb) > 5 {
				tb = tb[len(tb)-5:]
			}
			errPart += "\n" + strings.Join(tb, "\n")
		}
		parts = append(parts, "error:\n"+truncateRunes(errPart, 4000))
	}
	if len(filesOut) > 0 {
		names := make([]string, 0, len(filesOut))
		for _, f := range filesOut {
			names = append(names, strings.TrimPrefix(f.Path, e2b.SandboxWorkDir+"/output/"))
		}
		parts = append(parts, "files_out:\n  "+strings.Join(names, "\n  "))
	}
	if len(parts) == 0 {
		return "(code executed; no output)"
	}
	return strings.Join(parts, "\n\n")
}

// mustMap converts a typed struct to map[string]any via JSON round-trip.
// Used so the agentToolExecuteResult.Data field can serialize uniformly
// with other tools (web.search, image.*) that already use raw maps.
// Errors here would mean a programming bug in codeExecData, hence the
// "must" prefix — we log + return an empty map rather than crash so a
// future schema bug surfaces as a downstream display issue, not a 500.
func mustMap(in codeExecData) map[string]any {
	return map[string]any{
		"source":       in.Source,
		"sandbox_id":   in.SandboxID,
		"session_id":   in.SessionID,
		"stdout":       in.Stdout,
		"stderr":       in.Stderr,
		"error_name":   in.ErrorName,
		"error_value":  in.ErrorValue,
		"traceback":    in.Traceback,
		"results":      in.Results,
		"files_out":    in.FilesOut,
		"execution_ms": in.ExecutionMs,
	}
}

// argCodeExecFiles pulls the files_in argument out of the tool call
// args map. Tolerant of missing / null / wrong-shaped entries — we
// drop bad ones with no error so a partial schema bug doesn't fail
// the whole call. Pairs with decodeCodeExecFiles which does the real
// content validation.
func argCodeExecFiles(args map[string]any, key string) []codeExecFileIn {
	raw, ok := args[key]
	if !ok || raw == nil {
		return nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]codeExecFileIn, 0, len(list))
	for _, item := range list {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		path, _ := obj["path"].(string)
		content, _ := obj["content_b64"].(string)
		if path == "" || content == "" {
			continue
		}
		out = append(out, codeExecFileIn{Path: path, ContentB64: content})
	}
	return out
}

// decodeCodeExecFiles validates path safety + decodes base64 once
// upfront so we don't waste a credit reservation on bad input. Each
// returned entry has the raw bytes ready for upload.
func decodeCodeExecFiles(files []codeExecFileIn) ([]decodedCodeExecFile, error) {
	if len(files) == 0 {
		return nil, nil
	}
	out := make([]decodedCodeExecFile, 0, len(files))
	var total int64
	for _, f := range files {
		if strings.Contains(f.Path, "..") || strings.HasPrefix(f.Path, "/") {
			return nil, fmt.Errorf("invalid path %q: must be workspace-relative", f.Path)
		}
		data, err := base64Decode(f.ContentB64)
		if err != nil {
			return nil, fmt.Errorf("decode %q: %v", f.Path, err)
		}
		total += int64(len(data))
		if total > codeExecFilesMaxBytes {
			return nil, fmt.Errorf("files_in exceed %d byte cap", codeExecFilesMaxBytes)
		}
		out = append(out, decodedCodeExecFile{Path: f.Path, Data: data})
	}
	return out, nil
}

type decodedCodeExecFile struct {
	Path string
	Data []byte
}

// uploadCodeExecFiles puts each file at /home/user/<path> inside the
// sandbox (the code-interpreter's CWD). Errors fail-fast — better to
// refund credits and surface an error than to run code that'll just
// crash on missing files.
func (s *Server) uploadCodeExecFiles(ctx context.Context, rec store.SandboxSessionRecord, files []decodedCodeExecFile) error {
	if len(files) == 0 {
		return nil
	}
	for _, f := range files {
		sandboxPath := e2b.SandboxWorkDir + "/" + strings.TrimLeft(f.Path, "/")
		if err := s.app.E2BSessions.Client().UploadSandboxFile(ctx, rec.E2BSandboxID, rec.E2BClientID, sandboxPath, f.Data); err != nil {
			return err
		}
	}
	return nil
}

// runCodeWithSandbox does the provision → upload → run cycle, with a
// single retry on "sandbox vanished from E2B's side" (ErrSandboxNotFound).
// The retry re-provisions the sandbox AND re-uploads `files` — the
// prior version of this code silently ran against an empty /workspace
// on retry, leading to guaranteed FileNotFoundError that still burned
// the user's full credit budget.
//
// We do at most ONE retry: if the fresh sandbox also vanishes, that's
// a system-level problem and the agent gets the error envelope.
func (s *Server) runCodeWithSandbox(
	ctx context.Context,
	userID string,
	conversationID string,
	code string,
	language string,
	files []decodedCodeExecFile,
) (e2b.CodeExecuteResult, store.SandboxSessionRecord, error) {
	sessionRec, err := s.app.E2BSessions.GetOrCreateForConversation(ctx, userID, conversationID)
	if err != nil {
		return e2b.CodeExecuteResult{}, store.SandboxSessionRecord{}, fmt.Errorf("sandbox_provision: %w", err)
	}
	if err := s.uploadCodeExecFiles(ctx, sessionRec, files); err != nil {
		// Upload failure isn't necessarily a stale-sandbox signal —
		// could be transient transport error. Surface unchanged.
		return e2b.CodeExecuteResult{}, sessionRec, fmt.Errorf("file_upload: %w", err)
	}
	result, err := s.app.E2BSessions.RunCode(ctx, sessionRec, code, language)
	if err == nil {
		return result, sessionRec, nil
	}
	if !errors.Is(err, e2b.ErrSandboxNotFound) {
		return result, sessionRec, fmt.Errorf("run_code: %w", err)
	}
	// Sandbox vanished. Mark it failed, get a fresh one, re-upload,
	// retry RunCode once.
	_ = s.app.E2BSessions.InvalidateSession(ctx, sessionRec)
	freshRec, freshErr := s.app.E2BSessions.GetOrCreateForConversation(ctx, userID, conversationID)
	if freshErr != nil {
		return result, sessionRec, fmt.Errorf("resandbox_provision: %w", freshErr)
	}
	if err := s.uploadCodeExecFiles(ctx, freshRec, files); err != nil {
		return result, freshRec, fmt.Errorf("resandbox_upload: %w", err)
	}
	result, err = s.app.E2BSessions.RunCode(ctx, freshRec, code, language)
	if err != nil {
		return result, freshRec, fmt.Errorf("run_code_retry: %w", err)
	}
	return result, freshRec, nil
}

// classifyRunCodeError picks the error_code + HTTP status for the
// envelope based on what the underlying e2b/store wrapper returned.
// Centralizing it keeps the main runCodeExecute branch readable.
func classifyRunCodeError(err error) (errorCode string, status int) {
	if errors.Is(err, e2b.ErrSandboxNotFound) {
		return "sandbox_lost", http.StatusBadGateway
	}
	msg := err.Error()
	switch {
	case strings.HasPrefix(msg, "sandbox_provision:"),
		strings.HasPrefix(msg, "resandbox_provision:"):
		return "sandbox_provision_failed", http.StatusBadGateway
	case strings.HasPrefix(msg, "file_upload:"),
		strings.HasPrefix(msg, "resandbox_upload:"):
		return "file_upload_failed", http.StatusBadGateway
	default:
		return "code_exec_failed", http.StatusBadGateway
	}
}

// downloadCodeExecOutput lists /home/user/output/ in the sandbox
// after the run, downloads each non-directory entry, and returns
// them as the data.files_out payload. Capped at
// codeExecOutputMaxBytes total so one runaway script can't fill the
// daemon's response.
//
// We scope to /home/user/output/ (not /home/user/ root) so we don't
// round-trip the files_in we just uploaded. The agent is instructed
// in the tool docstring to write generated artifacts there.
func (s *Server) downloadCodeExecOutput(ctx context.Context, rec store.SandboxSessionRecord) ([]codeExecFileOut, error) {
	const outputDir = e2b.SandboxWorkDir + "/output"
	files, err := s.app.E2BSessions.Client().ListSandboxFiles(ctx, rec.E2BSandboxID, rec.E2BClientID, outputDir)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, nil
	}
	if len(files) > codeExecMaxFilesPerCall {
		files = files[:codeExecMaxFilesPerCall]
	}
	out := make([]codeExecFileOut, 0, len(files))
	var total int64
	for _, entry := range files {
		if entry.IsDir {
			continue
		}
		data, err := s.app.E2BSessions.Client().DownloadSandboxFile(ctx, rec.E2BSandboxID, rec.E2BClientID, entry.Path)
		if err != nil {
			// One bad file shouldn't lose the others — log and continue.
			continue
		}
		total += int64(len(data))
		if total > codeExecOutputMaxBytes {
			break
		}
		out = append(out, codeExecFileOut{
			Path:       entry.Path,
			ContentB64: base64Encode(data),
			Size:       int64(len(data)),
		})
	}
	return out, nil
}
