package app

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/coldflame/shejane/api/internal/llm"
	"github.com/coldflame/shejane/api/internal/modelreg"
)

// autoResolveTimeout bounds the classifier call — model selection must never
// noticeably delay a run; on timeout we just use the default model.
const autoResolveTimeout = 10 * time.Second

// autoResolveGoalLimit caps how much of the goal the classifier sees. The
// call is unbilled (platform cost), so the prompt is kept deliberately small.
const autoResolveGoalLimit = 2000

type modelCompleter interface {
	CompleteWithTools(context.Context, llm.ChatRequest, string) (llm.Completion, error)
}

// ResolveAutoModel implements "Auto": pick the most suitable chat model for a
// goal from the catalog. It runs ONE small classifier turn on the default
// (highest-priority) model and is deliberately UNBILLED — no Reserve/Settle.
// That's a product decision (we don't charge users for choosing a model);
// the cost is bounded by the tiny prompt + max-tokens-free short output, the
// 10s timeout, and the spend rate limiter on the public endpoint.
//
// It always returns a usable model: any failure (no catalog, classifier
// error/timeout, unparseable output) degrades to the default model with an
// empty reason. The reason is user-facing (badge tooltip), in Chinese.
func (a *App) ResolveAutoModel(ctx context.Context, goal string) (modelreg.ChatModelInfo, string) {
	candidates := a.Registry.ListChatModels()
	if len(candidates) == 0 {
		return modelreg.ChatModelInfo{}, ""
	}
	fallback := candidates[0] // highest priority == catalog default
	goal = strings.TrimSpace(goal)
	if len(candidates) == 1 || goal == "" {
		return fallback, ""
	}
	if runes := []rune(goal); len(runes) > autoResolveGoalLimit {
		goal = string(runes[:autoResolveGoalLimit])
	}

	provider, upstreamModel, _ := a.Router.SelectModel(fallback.ID)
	completer, ok := provider.(modelCompleter)
	if !ok {
		return fallback, ""
	}
	ctx, cancel := context.WithTimeout(ctx, autoResolveTimeout)
	defer cancel()
	completion, err := completer.CompleteWithTools(ctx, llm.ChatRequest{
		Model: fallback.ID,
		Scene: "model_route",
		Messages: []llm.Message{
			{Role: "system", Content: buildAutoResolvePrompt(candidates)},
			{Role: "user", Content: goal},
		},
	}, upstreamModel)
	if err != nil {
		return fallback, ""
	}
	id, reason := parseAutoResolveOutput(completion.Content, candidates)
	if id == "" {
		return fallback, ""
	}
	for _, c := range candidates {
		if c.ID == id {
			return c, reason
		}
	}
	return fallback, ""
}

// buildAutoResolvePrompt lists the catalog candidates (id + label +
// admin-written description, priority order) and asks for a strict JSON pick.
func buildAutoResolvePrompt(candidates []modelreg.ChatModelInfo) string {
	var b strings.Builder
	b.WriteString("你是模型路由器。根据用户任务,从下面的候选模型里选择最合适的一个。\n候选(按管理员偏好排序,不确定时选第一个):\n")
	for _, c := range candidates {
		b.WriteString("- id: ")
		b.WriteString(c.ID)
		b.WriteString(" | ")
		b.WriteString(c.Label)
		if c.Description != "" {
			b.WriteString(" — ")
			b.WriteString(c.Description)
		}
		b.WriteString("\n")
	}
	b.WriteString(`只输出一行 JSON,不要其他内容:{"model":"<候选里的 id>","reason":"<不超过15字的中文理由>"}`)
	return b.String()
}

// parseAutoResolveOutput parses the classifier reply leniently: first try the
// JSON object between the outermost braces; if that fails, scan the raw text
// for any candidate id. Returns ("", "") when nothing matches.
func parseAutoResolveOutput(content string, candidates []modelreg.ChatModelInfo) (string, string) {
	if start, end := strings.Index(content, "{"), strings.LastIndex(content, "}"); start >= 0 && end > start {
		var parsed struct {
			Model  string `json:"model"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal([]byte(content[start:end+1]), &parsed); err == nil {
			id := strings.TrimSpace(parsed.Model)
			for _, c := range candidates {
				if c.ID == id {
					return id, strings.TrimSpace(parsed.Reason)
				}
			}
		}
	}
	// Fallback: the model echoed an id without valid JSON.
	for _, c := range candidates {
		if strings.Contains(content, c.ID) {
			return c.ID, ""
		}
	}
	return "", ""
}
