package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coldflame/jiandanly/api/internal/billing"
	"github.com/coldflame/jiandanly/api/internal/store"
)

type toolCapability struct {
	Configured   bool   `json:"configured"`
	Provider     string `json:"provider"`
	CreditsCost  int64  `json:"credits_cost"`
	RequiresAuth bool   `json:"requires_auth"`
}

type toolCapabilitiesPayload struct {
	Tools map[string]toolCapability `json:"tools"`
}

type agentToolExecuteRequest struct {
	RunID          string         `json:"run_id"`
	ToolCallID     string         `json:"tool_call_id"`
	Tool           string         `json:"tool"`
	Arguments      map[string]any `json:"arguments"`
	IdempotencyKey string         `json:"idempotency_key"`
}

type agentToolExecuteResult struct {
	OK          bool           `json:"ok"`
	Content     string         `json:"content"`
	Data        map[string]any `json:"data,omitempty"`
	ErrorCode   string         `json:"errorCode,omitempty"`
	Recoverable bool           `json:"recoverable,omitempty"`
	Usage       map[string]any `json:"usage,omitempty"`
}

func (s *Server) agentToolCapabilities(w http.ResponseWriter, r *http.Request, user store.User) {
	writeJSON(w, http.StatusOK, apiResponse[toolCapabilitiesPayload]{
		Code:    0,
		Message: "ok",
		Data: toolCapabilitiesPayload{Tools: map[string]toolCapability{
			"web.search": {
				Configured:   strings.TrimSpace(s.app.Config.TavilyAPIKey) != "",
				Provider:     "tavily",
				CreditsCost:  positiveCredits(s.app.Config.TavilySearchCredits),
				RequiresAuth: true,
			},
			imageToolName:     s.imageToolCapability(r.Context()),
			imageEditToolName: s.imageToolCapability(r.Context()),
			codeExecToolName: {
				Configured:   s.app.IsCodeExecEnabled(),
				Provider:     "e2b",
				CreditsCost:  positiveCredits(s.app.Config.E2BCodeExecBaseCredits),
				RequiresAuth: true,
			},
			pdfInspectToolName: {
				// Always-configured: relies on poppler-utils
				// installed in the API container (alpine
				// apk add poppler-utils) plus the user's own
				// uploaded PDFs. No external API key.
				Configured:   true,
				Provider:     "poppler",
				CreditsCost:  pdfInspectCreditsCost,
				RequiresAuth: true,
			},
		}},
	})
}

func (s *Server) agentToolExecute(w http.ResponseWriter, r *http.Request, user store.User) {
	var body agentToolExecuteRequest
	// 300 MB cap — covers a max-size code.execute call (200 MB raw
	// files × 4/3 base64 overhead ≈ 267 MB, plus envelope headroom).
	// Image.* / web.search payloads are tiny — the larger cap costs
	// nothing for them, and bounds the worst-case allocation for
	// code.execute so a malicious daemon can't OOM the API.
	if !decodeLargeJSON(w, r, &body, 300<<20) {
		return
	}
	body.Tool = strings.TrimSpace(body.Tool)
	if body.Tool == imageToolName {
		result, status := s.runImageGeneration(r.Context(), user, imageGenInput{
			RunID:          body.RunID,
			ToolCallID:     body.ToolCallID,
			IdempotencyKey: body.IdempotencyKey,
			Prompt:         argString(body.Arguments, "prompt"),
			Size:           argString(body.Arguments, "size"),
			N:              argInt(body.Arguments, "n"),
		})
		code := 0
		if !result.OK {
			code = 1
		}
		writeJSON(w, status, apiResponse[agentToolExecuteResult]{Code: code, Message: result.Content, Data: result})
		return
	}
	if body.Tool == imageEditToolName {
		result, status := s.runImageEdit(r.Context(), user, imageEditInput{
			RunID:          body.RunID,
			ToolCallID:     body.ToolCallID,
			IdempotencyKey: body.IdempotencyKey,
			Prompt:         argString(body.Arguments, "prompt"),
			ImageURL:       argString(body.Arguments, "image_url"),
			MaskURL:        argString(body.Arguments, "mask_url"),
			DocumentID:     argString(body.Arguments, "document_id"),
			MaskDocumentID: argString(body.Arguments, "mask_document_id"),
			Size:           argString(body.Arguments, "size"),
			N:              argInt(body.Arguments, "n"),
		})
		code := 0
		if !result.OK {
			code = 1
		}
		writeJSON(w, status, apiResponse[agentToolExecuteResult]{Code: code, Message: result.Content, Data: result})
		return
	}
	if body.Tool == codeExecToolName {
		result, status := s.runCodeExecute(r.Context(), user, codeExecInput{
			RunID:          body.RunID,
			ToolCallID:     body.ToolCallID,
			IdempotencyKey: body.IdempotencyKey,
			ConversationID: argString(body.Arguments, "conversation_id"),
			Code:           argString(body.Arguments, "code"),
			Language:       argString(body.Arguments, "language"),
			FilesIn:        argCodeExecFiles(body.Arguments, "files_in"),
		})
		code := 0
		if !result.OK {
			code = 1
		}
		writeJSON(w, status, apiResponse[agentToolExecuteResult]{Code: code, Message: result.Content, Data: result})
		return
	}
	if body.Tool == pdfInspectToolName {
		result, status := s.runPdfInspect(r.Context(), user, pdfInspectInput{
			RunID:          body.RunID,
			ToolCallID:     body.ToolCallID,
			IdempotencyKey: body.IdempotencyKey,
			DocumentID:     argString(body.Arguments, "document_id"),
			Operation:      argString(body.Arguments, "operation"),
			Query:          argString(body.Arguments, "query"),
		})
		code := 0
		if !result.OK {
			code = 1
		}
		writeJSON(w, status, apiResponse[agentToolExecuteResult]{Code: code, Message: result.Content, Data: result})
		return
	}
	if body.Tool != "web.search" {
		writeJSON(w, http.StatusBadRequest, apiResponse[agentToolExecuteResult]{
			Code:    40040,
			Message: "unsupported tool",
			Data:    toolError("unsupported_tool", "Only web.search / image.* / code.execute / pdf.inspect are supported by the cloud tool gateway in this phase."),
		})
		return
	}
	if strings.TrimSpace(s.app.Config.TavilyAPIKey) == "" {
		writeJSON(w, http.StatusBadRequest, apiResponse[agentToolExecuteResult]{
			Code:    40041,
			Message: "tool not configured",
			Data:    toolError("web_search_disabled", "web.search is disabled because Tavily is not configured in the cloud API."),
		})
		return
	}

	idempotencyKey := strings.TrimSpace(body.IdempotencyKey)
	if idempotencyKey == "" {
		idempotencyKey = strings.Join([]string{body.RunID, body.ToolCallID, body.Tool}, ":")
	}
	if existing, err := s.app.Store.ExternalToolCallByIdempotencyKey(r.Context(), user.ID, idempotencyKey); err == nil && existing.Status == "done" {
		writeJSON(w, http.StatusOK, apiResponse[agentToolExecuteResult]{Code: 0, Message: "ok", Data: resultFromToolRecord(existing)})
		return
	}

	creditsCost := positiveCredits(s.app.Config.TavilySearchCredits)
	requestID := requestIDFromContext(r.Context(), s.app.NewRequestID())
	reservation, err := s.app.Store.ReserveUsage(r.Context(), user.ID, s.app.Config.MonthlyCredits, creditsCost, billing.ReservationMeta{
		UserID:    user.ID,
		RequestID: requestID,
		Mode:      "tool",
	})
	if err != nil {
		if billing.IsInsufficientCredits(err) {
			writeError(w, http.StatusPaymentRequired, 40202, "额度不足，请升级或充值")
			return
		}
		writeError(w, http.StatusInternalServerError, 50001, "额度预留失败")
		return
	}

	record, created, err := s.app.Store.CreateExternalToolCall(r.Context(), store.ExternalToolCallRecord{
		RequestID:      requestID,
		UserID:         user.ID,
		WalletID:       reservation.WalletID,
		ReservationID:  reservation.ID,
		RunID:          body.RunID,
		ToolCallID:     body.ToolCallID,
		Tool:           body.Tool,
		Provider:       "tavily",
		Status:         "running",
		IdempotencyKey: idempotencyKey,
		StartedAt:      time.Now().UTC(),
	})
	if err != nil {
		_ = s.app.Store.ReleaseUsage(r.Context(), user.ID, reservation.ID)
		writeError(w, http.StatusInternalServerError, 50001, "记录工具调用失败")
		return
	}
	if !created {
		_ = s.app.Store.ReleaseUsage(r.Context(), user.ID, reservation.ID)
		if record.Status == "done" {
			writeJSON(w, http.StatusOK, apiResponse[agentToolExecuteResult]{Code: 0, Message: "ok", Data: resultFromToolRecord(record)})
			return
		}
		writeJSON(w, http.StatusConflict, apiResponse[agentToolExecuteResult]{
			Code:    40901,
			Message: "tool call already in progress",
			Data:    toolError("tool_call_in_progress", "This tool call idempotency key is already being processed."),
		})
		return
	}

	result, units, err := s.executeTavilySearch(r.Context(), body.Arguments)
	if err != nil {
		_ = s.app.Store.ReleaseUsage(r.Context(), user.ID, reservation.ID)
		_ = s.app.Store.FinishExternalToolCall(r.Context(), requestID, "failed", 0, 0, result.ErrorCode, truncateProviderError(err.Error()), result.Content, result.Data)
		writeJSON(w, http.StatusBadGateway, apiResponse[agentToolExecuteResult]{Code: 50203, Message: "tool provider failed", Data: result})
		return
	}
	if err := s.app.Store.SettleUsage(r.Context(), user.ID, reservation.ID, creditsCost); err != nil {
		_ = s.app.Store.FinishExternalToolCall(r.Context(), requestID, "failed", units, 0, "settlement_failed", err.Error(), result.Content, result.Data)
		if billing.IsInsufficientCredits(err) {
			writeError(w, http.StatusPaymentRequired, 40202, "额度不足，请升级或充值")
			return
		}
		writeError(w, http.StatusInternalServerError, 50001, "额度结算失败")
		return
	}
	result.Usage = map[string]any{
		"credits_cost": creditsCost,
		"units":        units,
		"request_id":   requestID,
	}
	result.Data["request_id"] = requestID
	if err := s.app.Store.FinishExternalToolCall(r.Context(), requestID, "done", units, creditsCost, "", "", result.Content, result.Data); err != nil {
		writeError(w, http.StatusInternalServerError, 50001, "记录工具调用完成失败")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse[agentToolExecuteResult]{Code: 0, Message: "ok", Data: result})
}

func (s *Server) executeTavilySearch(ctx context.Context, arguments map[string]any) (agentToolExecuteResult, int, error) {
	query, _ := arguments["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		result := toolError("query_required", "A search query is required.")
		return result, 0, errors.New("query_required")
	}
	maxResults := 5
	switch value := arguments["maxResults"].(type) {
	case float64:
		maxResults = int(value)
	case int:
		maxResults = value
	}
	if maxResults < 1 {
		maxResults = 1
	}
	if maxResults > 10 {
		maxResults = 10
	}

	requestCtx, cancel := context.WithTimeout(ctx, s.app.Config.ToolGatewayTimeout)
	defer cancel()
	payload, _ := json.Marshal(map[string]any{
		"query":               query,
		"search_depth":        "basic",
		"include_answer":      true,
		"include_raw_content": false,
		"max_results":         maxResults,
	})
	baseURL := strings.TrimRight(s.app.Config.TavilyBaseURL, "/")
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, baseURL+"/search", bytes.NewReader(payload))
	if err != nil {
		return toolError("web_search_failed", "Failed to create Tavily request."), 0, err
	}
	req.Header.Set("Authorization", "Bearer "+s.app.Config.TavilyAPIKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: s.app.Config.ToolGatewayTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return toolError("web_search_failed", "Tavily search failed."), 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		message := fmt.Sprintf("Tavily search returned HTTP %d.", resp.StatusCode)
		return toolError("web_search_failed", message), 0, fmt.Errorf("%s %s", message, truncateProviderError(string(body)))
	}
	var body struct {
		Answer  string `json:"answer"`
		Results []struct {
			Title   string  `json:"title"`
			URL     string  `json:"url"`
			Content string  `json:"content"`
			Score   float64 `json:"score"`
		} `json:"results"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return toolError("web_search_failed", "Failed to decode Tavily response."), 0, err
	}
	results := make([]map[string]any, 0, len(body.Results))
	contentParts := make([]string, 0, len(body.Results)+1)
	if strings.TrimSpace(body.Answer) != "" {
		contentParts = append(contentParts, "Answer: "+strings.TrimSpace(body.Answer))
	}
	for index, result := range body.Results {
		if index >= maxResults {
			break
		}
		item := map[string]any{
			"title":   result.Title,
			"url":     result.URL,
			"content": truncateRunes(result.Content, 700),
			"score":   result.Score,
		}
		results = append(results, item)
		contentParts = append(contentParts, strings.Join([]string{
			fmt.Sprintf("%d. %s", len(results), result.Title),
			result.URL,
			truncateRunes(result.Content, 700),
		}, "\n"))
	}
	data := map[string]any{
		"provider":      "tavily",
		"results_count": len(results),
		"results":       results,
		"source":        "web.search",
	}
	return agentToolExecuteResult{
		OK:      true,
		Content: strings.Join(contentParts, "\n\n"),
		Data:    data,
	}, 1, nil
}

func resultFromToolRecord(record store.ExternalToolCallRecord) agentToolExecuteResult {
	return agentToolExecuteResult{
		OK:      record.Status == "done",
		Content: record.ResponseContent,
		Data:    record.ResponseData,
		Usage: map[string]any{
			"credits_cost": record.CreditsCost,
			"units":        record.Units,
			"request_id":   record.RequestID,
		},
	}
}

func toolError(code string, message string) agentToolExecuteResult {
	return agentToolExecuteResult{
		OK:          false,
		Content:     message,
		ErrorCode:   code,
		Recoverable: true,
		Data:        map[string]any{"source": "cloud_tool_gateway"},
	}
}

func positiveCredits(value int64) int64 {
	if value < 1 {
		return 1
	}
	return value
}

func truncateProviderError(value string) string {
	return truncateRunes(strings.TrimSpace(value), 500)
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "..."
}
