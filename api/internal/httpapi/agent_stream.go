package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coldflame/shejane/api/internal/billing"
	"github.com/coldflame/shejane/api/internal/llm"
	"github.com/coldflame/shejane/api/internal/store"
)

// agentLLMStream is the SSE-streaming counterpart to agentLLMGateway.
//
// Used by the Python LangGraph sidecar (Phase 2+) to pull token-level deltas
// while a graph node is running. Same auth, same credit reserve/settle path,
// same provider routing — only the response shape differs.
//
// Event schema (matches docs/spike-phase0-langgraph.md and the migration plan):
//
//	event: llm.delta
//	data: {"content_delta":"...","reasoning_delta":"..."}
//
//	event: llm.tool_call
//	data: {"id":"call_1","name":"fs.read","arguments":{...}}
//
//	event: llm.usage
//	data: {"input_tokens":1234,"output_tokens":567,"credits_cost":12}
//
//	event: llm.done
//	data: {"request_id":"req_abc","finish_reason":"stop"}
//
// On error, an `event: llm.error` is emitted, then `llm.done`. Credits are
// always released or settled before the handler returns.
func (s *Server) agentLLMStream(w http.ResponseWriter, r *http.Request, user store.User) {
	body, err := decodeAgentLLMBody(w, r)
	if err != nil {
		return // decodeAgentLLMBody already wrote the response
	}
	messages := agentBodyMessages(body)
	tools := agentBodyTools(body)
	// Resolve the requested model (id / "auto" / "") to a live provider + the
	// concrete catalog model id used for billing + records.
	provider, model, modelID := s.app.Router.SelectModel(body.Model)
	// Prepend the agent_local scene prompt (Layer 0+10 of the prompt
	// stack: identity + safety). Daemon-side ContextBuilder owns
	// Layer 20+ (developer instructions, memory, runtime context),
	// which already arrive in `messages` as a SystemMessage from
	// create_deep_agent's `instructions=`. We always want cloud's
	// identity prompt to be FIRST so daemon-side instructions can't
	// override the user-facing identity / safety contract.
	messages = llm.InjectScenePrompt("agent_local", messages)
	request := llm.ChatRequest{
		Model:    modelID,
		Stream:   true,
		Scene:    "agent_local",
		Messages: messages,
		Tools:    tools,
	}

	requestID := requestIDFromContext(r.Context(), s.app.NewRequestID())
	estimatedCredits := s.app.EstimateCredits(request)

	reservation, err := s.app.Store.ReserveUsage(r.Context(), user.ID, s.app.Config.MonthlyCredits, estimatedCredits, billing.ReservationMeta{
		UserID:    user.ID,
		RequestID: requestID,
		Mode:      modelID,
	})
	if err != nil {
		if billing.IsInsufficientCredits(err) {
			writeError(w, http.StatusPaymentRequired, 40202, "额度不足，请升级或充值")
			return
		}
		writeError(w, http.StatusInternalServerError, 50001, "额度预留失败")
		return
	}

	if err := s.app.Store.CreateLLMCall(r.Context(), store.LLMCallRecord{
		RequestID:     requestID,
		UserID:        user.ID,
		WalletID:      reservation.WalletID,
		ReservationID: reservation.ID,
		Mode:          modelID,
		Scene:         "agent_local",
		Model:         model,
		Provider:      provider.Name(),
		Status:        "streaming",
		StartedAt:     time.Now().UTC(),
	}); err != nil {
		_ = s.app.Store.ReleaseUsage(r.Context(), user.ID, reservation.ID)
		writeError(w, http.StatusInternalServerError, 50001, "记录调用失败")
		return
	}

	// All headers must be set before WriteHeader; once we go SSE we cannot
	// switch back to a JSON error body.
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	streamErr, inputTokens, outputTokens, finishReason := s.runAgentLLMStream(r.Context(), w, provider, request, model, requestID)

	if streamErr != nil {
		_ = s.app.Store.ReleaseUsage(r.Context(), user.ID, reservation.ID)
		_ = s.app.Store.FinishLLMCall(r.Context(), requestID, "failed", inputTokens, outputTokens, 0, streamErr.Error())
		_ = writeLLMSSEEvent(w, "llm.error", map[string]any{
			"request_id": requestID,
			"message":    streamErr.Error(),
		})
		_ = writeLLMSSEEvent(w, "llm.done", map[string]any{
			"request_id":    requestID,
			"finish_reason": "error",
		})
		flushSSE(w)
		return
	}

	if inputTokens < 1 {
		inputTokens = llm.EstimateTokens(request.Messages)
	}

	actualCredits := s.app.UsageCredits(modelID, inputTokens+outputTokens)
	if err := s.app.Store.SettleUsage(r.Context(), user.ID, reservation.ID, actualCredits); err != nil {
		_ = s.app.Store.FinishLLMCall(r.Context(), requestID, "failed", inputTokens, outputTokens, 0, err.Error())
		message := "额度结算失败"
		if billing.IsInsufficientCredits(err) {
			message = "额度不足，请升级或充值"
		}
		_ = writeLLMSSEEvent(w, "llm.error", map[string]any{
			"request_id": requestID,
			"message":    message,
		})
		_ = writeLLMSSEEvent(w, "llm.done", map[string]any{
			"request_id":    requestID,
			"finish_reason": "error",
		})
		flushSSE(w)
		return
	}

	_ = s.app.Store.FinishLLMCall(r.Context(), requestID, "done", inputTokens, outputTokens, actualCredits, "")
	_ = writeLLMSSEEvent(w, "llm.usage", map[string]any{
		"input_tokens":  inputTokens,
		"output_tokens": outputTokens,
		"credits_cost":  actualCredits,
	})
	_ = writeLLMSSEEvent(w, "llm.done", map[string]any{
		"request_id":    requestID,
		"finish_reason": finishReason,
	})
	flushSSE(w)
}

// runAgentLLMStream picks between true streaming (no tools) and a blocking
// completion (tools requested) and emits the appropriate SSE events. It
// returns final input/output token counts and a finish reason, or an error
// if the upstream LLM call failed.
//
// Phase 1 limitation: when tools are requested, the upstream provider is
// called non-streaming via CompleteWithTools and the final content is emitted
// as a single llm.delta. Per-token streaming for tool requests is a Phase 4
// improvement requiring provider-layer changes (see migration plan §4).
func (s *Server) runAgentLLMStream(
	ctx context.Context,
	w http.ResponseWriter,
	provider llm.Provider,
	request llm.ChatRequest,
	model string,
	requestID string,
) (streamErr error, inputTokens int, outputTokens int, finishReason string) {
	if len(request.Tools) > 0 {
		completer, ok := provider.(agentToolCompleter)
		if ok {
			completion, err := completer.CompleteWithTools(ctx, request, model)
			if err != nil {
				return err, 0, 0, ""
			}
			if completion.Content != "" || completion.ReasoningContent != "" {
				_ = writeLLMSSEEvent(w, "llm.delta", map[string]any{
					"content_delta":   completion.Content,
					"reasoning_delta": completion.ReasoningContent,
				})
				flushSSE(w)
			}
			for _, call := range completion.ToolCalls {
				_ = writeLLMSSEEvent(w, "llm.tool_call", map[string]any{
					"id":        call.ID,
					"name":      call.Name,
					"arguments": call.Arguments,
				})
				flushSSE(w)
			}
			finish := completion.FinishReason
			if finish == "" {
				if len(completion.ToolCalls) > 0 {
					finish = "tool_calls"
				} else {
					finish = "stop"
				}
			}
			return nil, completion.InputTokens, completion.OutputTokens, finish
		}
		// Provider does not implement CompleteWithTools — fall through to
		// pure-text streaming. Tools are silently dropped; the caller will
		// see no llm.tool_call events. Acceptable Phase 1 behaviour for
		// providers like Anthropic that only stream text.
	}

	chunks, errs := provider.Stream(ctx, request, model)
	for chunk := range chunks {
		if chunk.InputTokens > 0 {
			inputTokens = chunk.InputTokens
		}
		if chunk.OutputTokens > outputTokens {
			outputTokens = chunk.OutputTokens
		}
		if chunk.Text != "" {
			_ = writeLLMSSEEvent(w, "llm.delta", map[string]any{
				"content_delta":   chunk.Text,
				"reasoning_delta": "",
			})
			flushSSE(w)
		}
		if chunk.FinishReason != "" {
			finishReason = chunk.FinishReason
		}
	}
	if err := <-errs; err != nil {
		return err, inputTokens, outputTokens, ""
	}
	if finishReason == "" {
		finishReason = "stop"
	}
	return nil, inputTokens, outputTokens, finishReason
}

// writeLLMSSEEvent writes a single SSE event of `event: <name>\ndata: <json>\n\n`.
func writeLLMSSEEvent(w io.Writer, event string, payload map[string]any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded)
	return err
}

// agentLLMBody is the shared request shape between agentLLMGateway and
// agentLLMStream. Kept identical so the Python sidecar can switch transports
// without touching its request builder.
type agentLLMBody struct {
	RunID string `json:"run_id"`
	// Model is the catalog model id, or "auto"/"" for the default. (Replaces
	// the old fast/deep "mode" — the daemon now forwards the user's model.)
	Model    string `json:"model"`
	Messages []struct {
		Role                  string `json:"role"`
		Content               string `json:"content"`
		ReasoningContent      string `json:"reasoningContent,omitempty"`
		ReasoningContentSnake string `json:"reasoning_content,omitempty"`
		ToolCallID            string `json:"toolCallId,omitempty"`
		Name                  string `json:"name,omitempty"`
		ToolCalls             []struct {
			ID        string         `json:"id"`
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		} `json:"toolCalls,omitempty"`
	} `json:"messages"`
	Tools []struct {
		Name              string         `json:"name"`
		Description       string         `json:"description"`
		InputSchema       map[string]any `json:"inputSchema"`
		IsReadOnly        bool           `json:"isReadOnly"`
		IsDestructive     bool           `json:"isDestructive"`
		IsConcurrencySafe bool           `json:"isConcurrencySafe"`
		MaxResultSize     int            `json:"maxResultSize"`
		PermissionPolicy  string         `json:"permissionPolicy"`
	} `json:"tools"`
}

func decodeAgentLLMBody(w http.ResponseWriter, r *http.Request) (*agentLLMBody, error) {
	body := &agentLLMBody{}
	if !decodeJSON(w, r, body) {
		return nil, fmt.Errorf("decode failed")
	}
	if len(body.Messages) == 0 {
		writeError(w, http.StatusBadRequest, 40201, "消息不能为空")
		return nil, fmt.Errorf("empty messages")
	}
	return body, nil
}

func agentBodyMessages(body *agentLLMBody) []llm.Message {
	out := make([]llm.Message, 0, len(body.Messages))
	for _, message := range body.Messages {
		role := strings.TrimSpace(message.Role)
		if role == "" {
			role = "user"
		}
		toolCalls := make([]llm.ToolCall, 0, len(message.ToolCalls))
		for _, call := range message.ToolCalls {
			toolCalls = append(toolCalls, llm.ToolCall{ID: call.ID, Name: call.Name, Arguments: call.Arguments})
		}
		reasoningContent := message.ReasoningContent
		if reasoningContent == "" {
			reasoningContent = message.ReasoningContentSnake
		}
		out = append(out, llm.Message{
			Role:             role,
			Content:          message.Content,
			ReasoningContent: reasoningContent,
			ToolCallID:       message.ToolCallID,
			Name:             message.Name,
			ToolCalls:        toolCalls,
		})
	}
	return out
}

func agentBodyTools(body *agentLLMBody) []llm.ToolDefinition {
	out := make([]llm.ToolDefinition, 0, len(body.Tools))
	for _, tool := range body.Tools {
		if strings.TrimSpace(tool.Name) == "" {
			continue
		}
		out = append(out, llm.ToolDefinition{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.InputSchema,
		})
	}
	return out
}
