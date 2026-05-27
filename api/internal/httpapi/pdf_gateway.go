// pdf_gateway.go — server-side implementation of the `pdf.inspect`
// tool. The agent calls it via the cloud tool gateway when it needs
// PDF operations beyond "read the extracted text" (which Layer A
// already covers via documents.Document.Metadata + the existing
// text extraction path).
//
// Design note: the originally-sketched architecture ran these
// operations inside the E2B sandbox alongside code.execute. After
// Layer A shipped, the API container already has poppler-utils
// installed, so for the FIRST cut we run pdftotext / pdfinfo /
// pdfgrep directly in the API process. Trade-offs:
//
//   In-container (current):
//     + No E2B credit cost / cold-start
//     + Simpler implementation (no sandbox provisioning)
//     + Reuses the Poppler install we shipped for Layer A
//     − API process consumes CPU for the operation (bounded by
//       per-op timeouts + a single-PDF size cap)
//     − No tenant isolation beyond OS process boundaries
//
//   In-E2B (future option):
//     + Strong isolation per tenant
//     + Resource limits enforced by the microVM
//     − ~5 credits + ~2s cold start per call
//     − More moving parts
//
// We can lift the inner implementation to E2B later (the agent-
// facing surface stays the same — daemon tool + gateway tool name)
// if traffic grows enough that the API container's CPU budget
// becomes a real concern.

package httpapi

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/coldflame/jiandanly/api/internal/billing"
	"github.com/coldflame/jiandanly/api/internal/documents"
	"github.com/coldflame/jiandanly/api/internal/store"
)

const pdfInspectToolName = "pdf.inspect"

// Per-call hard ceiling. Inspect operations finish in well under a
// second for sane PDFs; this guards against a corrupt file pinning
// CPU. Same value Layer A uses for upload-time extraction.
const pdfInspectTimeout = 30 * time.Second

// Flat credit cost per pdf.inspect call. Way cheaper than image
// generation; comparable to web.search. Each operation is bounded
// in CPU/memory at the OS level, so flat-rate (rather than
// per-page) is a reasonable simplification.
const pdfInspectCreditsCost int64 = 2

type pdfInspectInput struct {
	RunID          string
	ToolCallID     string
	IdempotencyKey string
	DocumentID     string
	Operation      string
	Query          string // for search
}

// runPdfInspect: validates ownership of the target document, fetches
// bytes via Documents.ReadSource (which checks expiry + ready), then
// dispatches by operation. Bills a flat 2 credits on success.
//
// Errors all return a tool-shaped result envelope (ok=false +
// errorCode) so the daemon can hand a clean message to the LLM.
func (s *Server) runPdfInspect(ctx context.Context, user store.User, in pdfInspectInput) (agentToolExecuteResult, int) {
	op := strings.ToLower(strings.TrimSpace(in.Operation))
	docID := strings.TrimSpace(in.DocumentID)
	if docID == "" {
		return toolError("missing_document_id", "pdf.inspect requires document_id"), 400
	}
	if op == "" {
		return toolError("missing_operation", "pdf.inspect requires operation (one of: info, search)"), 400
	}

	// Re-uses the existing read path so we get expiry + ready checks
	// for free and stay consistent with documents.ask.
	data, contentType, originalName, err := s.app.Documents.ReadSource(ctx, user.ID, docID)
	if err != nil {
		if errors.Is(err, documents.ErrExpired) {
			return toolError("document_expired", "the document has expired and is no longer available"), 410
		}
		if errors.Is(err, documents.ErrNotReady) {
			return toolError("document_not_ready", "the document is still being processed; try again shortly"), 409
		}
		if errors.Is(err, store.ErrNotFound) {
			return toolError("document_not_found", "no document with that id is owned by the current user"), 404
		}
		return toolError("document_read_failed", fmt.Sprintf("could not read document: %v", err)), 500
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "application/pdf") {
		return toolError("not_a_pdf", fmt.Sprintf("pdf.inspect only handles PDFs (got %s)", contentType)), 400
	}

	idempotencyKey := strings.TrimSpace(in.IdempotencyKey)
	if idempotencyKey == "" {
		idempotencyKey = strings.Join([]string{in.RunID, in.ToolCallID, pdfInspectToolName, op}, ":")
	}
	if existing, lookupErr := s.app.Store.ExternalToolCallByIdempotencyKey(ctx, user.ID, idempotencyKey); lookupErr == nil && existing.Status == "done" {
		return resultFromToolRecord(existing), 200
	}

	// Reserve credits before running. Settled to actual cost (= flat
	// fee on success) or released on failure. Worst-case the agent
	// pays 2 credits for an op that returns "no matches" — that's
	// the same shape web.search uses.
	requestID := requestIDFromContext(ctx, s.app.NewRequestID())
	reservation, resErr := s.app.Store.ReserveUsage(ctx, user.ID, s.app.Config.MonthlyCredits, pdfInspectCreditsCost, billing.ReservationMeta{
		UserID:    user.ID,
		RequestID: requestID,
		Mode:      "tool",
	})
	if resErr != nil {
		if billing.IsInsufficientCredits(resErr) {
			return toolError("insufficient_credits", "not enough credits to run pdf.inspect"), 402
		}
		return toolError("reservation_failed", "could not reserve credits"), 500
	}

	record, created, recErr := s.app.Store.CreateExternalToolCall(ctx, store.ExternalToolCallRecord{
		RequestID:      requestID,
		UserID:         user.ID,
		WalletID:       reservation.WalletID,
		ReservationID:  reservation.ID,
		RunID:          in.RunID,
		ToolCallID:     in.ToolCallID,
		Tool:           pdfInspectToolName,
		Provider:       "poppler",
		Status:         "running",
		IdempotencyKey: idempotencyKey,
		StartedAt:      time.Now().UTC(),
	})
	if recErr != nil {
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		return toolError("record_create_failed", "could not record tool call"), 500
	}
	if !created {
		// Same idempotency-cache pattern as the other gateways:
		// released reservation, returned cached row if done.
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		if record.Status == "done" {
			return resultFromToolRecord(record), 200
		}
		return toolError("tool_call_in_progress", "this pdf.inspect call is already running"), 409
	}

	var result agentToolExecuteResult
	switch op {
	case "info":
		result = runPdfInfo(ctx, data, originalName)
	case "search":
		result = runPdfSearch(ctx, data, in.Query)
	default:
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		_ = s.app.Store.FinishExternalToolCall(ctx, requestID, "failed", 0, 0, "unknown_operation", "", "", nil)
		return toolError("unknown_operation", fmt.Sprintf("unknown operation %q (supported: info, search)", op)), 400
	}

	if !result.OK {
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		_ = s.app.Store.FinishExternalToolCall(ctx, requestID, "failed", 0, 0, result.ErrorCode, "", result.Content, result.Data)
		return result, 200
	}

	if settleErr := s.app.Store.SettleUsage(ctx, user.ID, reservation.ID, pdfInspectCreditsCost); settleErr != nil {
		// Same settle-failure pattern as web.search: explicit
		// release so a transient settle bug doesn't strand the
		// reservation, mark the call failed in the audit log.
		_ = s.app.Store.ReleaseUsage(ctx, user.ID, reservation.ID)
		_ = s.app.Store.FinishExternalToolCall(ctx, requestID, "failed", 0, 0, "settlement_failed", settleErr.Error(), result.Content, result.Data)
		if billing.IsInsufficientCredits(settleErr) {
			return toolError("insufficient_credits", "not enough credits"), 402
		}
		return toolError("settlement_failed", "credit settlement failed"), 500
	}

	result.Usage = map[string]any{
		"credits_cost": pdfInspectCreditsCost,
		"request_id":   requestID,
	}
	if result.Data == nil {
		result.Data = map[string]any{}
	}
	result.Data["request_id"] = requestID
	_ = s.app.Store.FinishExternalToolCall(ctx, requestID, "done", 1, pdfInspectCreditsCost, "", "", result.Content, result.Data)
	return result, 200
}

// runPdfInfo: shells out to `pdfinfo -` and returns the parsed map.
// Mostly redundant with documents.Document.Metadata (Layer A
// captures this at upload time) — exposed here so the agent has a
// uniform interface for "give me PDF metadata by id" without
// needing a separate fetch from the documents endpoint.
func runPdfInfo(ctx context.Context, data []byte, name string) agentToolExecuteResult {
	ctx, cancel := context.WithTimeout(ctx, pdfInspectTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pdfinfo", "-")
	cmd.Stdin = strings.NewReader(string(data))
	out, err := cmd.Output()
	if err != nil {
		// Often: encrypted PDF without password. Surface verbatim
		// so the agent can tell the user.
		return toolError("pdfinfo_failed", fmt.Sprintf("pdfinfo on %s: %v", name, err))
	}
	meta := documents.ParsePDFInfoBytes(out)
	pages := 0
	if p, ok := meta["pages"].(int); ok {
		pages = p
	}
	summary := fmt.Sprintf("Info for %s: %d page(s).", name, pages)
	if title, ok := meta["title"].(string); ok && title != "" {
		summary += " Title: " + title + "."
	}
	if author, ok := meta["author"].(string); ok && author != "" {
		summary += " Author: " + author + "."
	}
	return agentToolExecuteResult{
		OK:      true,
		Content: summary,
		Data:    map[string]any{"metadata": meta},
	}
}

// runPdfSearch: shells out to `pdfgrep -n -F <query> -` and parses
// the output into {page, line, snippet} records. -F = fixed string
// (avoids regex injection); -n = include line numbers. Truncates
// matches at 20 — agents that hit a real research need can refine
// the query rather than drown in hits.
func runPdfSearch(ctx context.Context, data []byte, query string) agentToolExecuteResult {
	query = strings.TrimSpace(query)
	if query == "" {
		return toolError("missing_query", "pdf.inspect operation=search requires a non-empty query")
	}
	ctx, cancel := context.WithTimeout(ctx, pdfInspectTimeout)
	defer cancel()
	// pdfgrep's "-" stdin variant: pdfgrep -n -F "query" -
	cmd := exec.CommandContext(ctx, "pdfgrep", "-n", "-F", query, "-")
	cmd.Stdin = strings.NewReader(string(data))
	out, err := cmd.Output()
	// pdfgrep exits 1 on "no matches" — that's a SUCCESS for us,
	// not an error. Distinguish from real subprocess failures.
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return agentToolExecuteResult{
				OK:      true,
				Content: fmt.Sprintf("No matches for %q in the PDF.", query),
				Data:    map[string]any{"matches": []any{}, "query": query},
			}
		}
		return toolError("pdfgrep_failed", fmt.Sprintf("pdfgrep: %v", err))
	}
	matches := parsePdfgrepOutput(out, 20)
	summary := fmt.Sprintf("Found %d match(es) for %q.", len(matches), query)
	if len(matches) == 0 {
		summary = fmt.Sprintf("No matches for %q in the PDF.", query)
	}
	return agentToolExecuteResult{
		OK:      true,
		Content: summary,
		Data: map[string]any{
			"matches": matches,
			"query":   query,
		},
	}
}

// parsePdfgrepOutput parses lines like
//
//	"42:Some matched snippet text"
//
// where the leading integer is the PAGE number (pdfgrep's -n flag).
// limit caps the result list to bound payload size.
func parsePdfgrepOutput(out []byte, limit int) []map[string]any {
	matches := make([]map[string]any, 0, 8)
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		colon := strings.Index(line, ":")
		if colon < 0 {
			// Defensive: pdfgrep without -n could omit the prefix;
			// still surface the snippet so the user sees something.
			matches = append(matches, map[string]any{"page": 0, "snippet": line})
		} else {
			pageStr := line[:colon]
			page, _ := strconv.Atoi(strings.TrimSpace(pageStr))
			matches = append(matches, map[string]any{
				"page":    page,
				"snippet": strings.TrimSpace(line[colon+1:]),
			})
		}
		if len(matches) >= limit {
			break
		}
	}
	return matches
}
