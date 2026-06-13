package app

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/coldflame/shejane/api/internal/llm"
	"github.com/coldflame/shejane/api/internal/modelreg"
	"github.com/coldflame/shejane/api/internal/store"
)

// autoResolveTimeout bounds the classifier call — model selection must never
// noticeably delay a run; on timeout we just use the default model.
const autoResolveTimeout = 10 * time.Second

// autoResolveGoalLimit caps how much of the goal the classifier sees. The
// call is unbilled (platform cost), so the prompt is kept deliberately small.
const autoResolveGoalLimit = 2000
const autoRouteStatsLimit = 500
const autoRouteHealthWindow = 30 * time.Minute

type modelCompleter interface {
	CompleteWithTools(context.Context, llm.ChatRequest, string) (llm.Completion, error)
}

type AutoResolveIntent string

const (
	AutoResolveIntentNeutral AutoResolveIntent = ""
	AutoResolveIntentFast    AutoResolveIntent = "fast"
	AutoResolveIntentSmart   AutoResolveIntent = "smart"
)

func IsAutoModelMode(mode string) bool {
	mode = strings.TrimSpace(mode)
	return mode == "" || mode == "auto" || mode == "auto.fast" || mode == "auto.smart"
}

func NormalizeAutoModelMode(mode string) string {
	mode = strings.TrimSpace(mode)
	if mode == "" {
		return "auto"
	}
	if IsAutoModelMode(mode) {
		return mode
	}
	return mode
}

func AutoIntentFromMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case "auto.fast":
		return string(AutoResolveIntentFast)
	case "auto.smart":
		return string(AutoResolveIntentSmart)
	default:
		return ""
	}
}

func NormalizeAutoResolveIntent(intent string) AutoResolveIntent {
	switch strings.ToLower(strings.TrimSpace(intent)) {
	case string(AutoResolveIntentFast):
		return AutoResolveIntentFast
	case string(AutoResolveIntentSmart):
		return AutoResolveIntentSmart
	default:
		return AutoResolveIntentNeutral
	}
}

func AutoRequestedLabel(mode string) string {
	switch strings.TrimSpace(mode) {
	case "auto.fast":
		return "更快"
	case "auto.smart":
		return "更强"
	default:
		return "自动"
	}
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
	return a.ResolveAutoModelWithIntent(ctx, goal, "")
}

func (a *App) ResolveAutoModelWithIntent(ctx context.Context, goal string, intent string) (modelreg.ChatModelInfo, string) {
	normalizedIntent := NormalizeAutoResolveIntent(intent)
	ranked := a.rankAutoCandidates(ctx, a.Registry.ListChatModels())
	if len(ranked) == 0 {
		return modelreg.ChatModelInfo{}, ""
	}
	goal = strings.TrimSpace(goal)
	difficulty := classifyAutoTaskDifficulty(goal)
	candidates := ranked
	hasFallbackReason := false
	if normalizedIntent != AutoResolveIntentNeutral {
		hasFallbackReason = true
		filtered := autoCandidatesForIntent(ranked, normalizedIntent)
		if len(filtered) > 0 {
			candidates = filtered
		}
	} else if goal != "" {
		filtered := autoCandidatesForDifficulty(ranked, difficulty)
		if len(filtered) == 0 {
			candidates = ranked
		} else {
			candidates = filtered
			hasFallbackReason = len(filtered) < len(ranked)
		}
	}
	fallback := candidates[0] // highest priority == catalog default
	if len(candidates) == 1 || goal == "" {
		if hasFallbackReason {
			return fallback, autoResolveFallbackReason(normalizedIntent, difficulty, goal)
		}
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
			{Role: "system", Content: buildAutoResolvePrompt(candidates, difficulty, normalizedIntent)},
			{Role: "user", Content: goal},
		},
	}, upstreamModel)
	if err != nil {
		return fallback, autoResolveFallbackReason(normalizedIntent, difficulty, goal)
	}
	id, reason := parseAutoResolveOutput(completion.Content, candidates)
	if id == "" {
		return fallback, autoResolveFallbackReason(normalizedIntent, difficulty, goal)
	}
	for _, c := range candidates {
		if c.ID == id {
			if strings.TrimSpace(reason) == "" {
				reason = autoResolveFallbackReason(normalizedIntent, difficulty, goal)
			}
			return c, reason
		}
	}
	return fallback, autoResolveFallbackReason(normalizedIntent, difficulty, goal)
}

// NextChatModel returns the next ranked chat model after a failing model. It is
// intentionally conservative: one hop only, same enabled catalog, ranked by the
// same health/cost/priority score Auto uses.
func (a *App) NextChatModel(ctx context.Context, currentID string) (modelreg.ChatModelInfo, bool) {
	for _, candidate := range a.rankAutoCandidates(ctx, a.Registry.ListChatModels()) {
		if candidate.ID != currentID {
			return candidate, true
		}
	}
	return modelreg.ChatModelInfo{}, false
}

type autoRouteStats struct {
	calls      int
	failures   int
	latencySum time.Duration
	latencies  int
}

func (s autoRouteStats) failureRate() float64 {
	if s.calls == 0 {
		return 0
	}
	return float64(s.failures) / float64(s.calls)
}

func (s autoRouteStats) avgLatencySeconds() float64 {
	if s.latencies == 0 {
		return 0
	}
	return s.latencySum.Seconds() / float64(s.latencies)
}

func (a *App) rankAutoCandidates(ctx context.Context, candidates []modelreg.ChatModelInfo) []modelreg.ChatModelInfo {
	if len(candidates) < 2 {
		return candidates
	}
	stats := a.recentAutoRouteStats(ctx)
	ranked := make([]modelreg.ChatModelInfo, len(candidates))
	copy(ranked, candidates)
	sort.SliceStable(ranked, func(i, j int) bool {
		left := a.autoCandidateScore(ranked[i], stats[ranked[i].ID])
		right := a.autoCandidateScore(ranked[j], stats[ranked[j].ID])
		if math.Abs(left-right) > 0.0001 {
			return left > right
		}
		if ranked[i].Priority != ranked[j].Priority {
			return ranked[i].Priority > ranked[j].Priority
		}
		return ranked[i].ID < ranked[j].ID
	})
	return ranked
}

func (a *App) autoCandidateScore(candidate modelreg.ChatModelInfo, stats autoRouteStats) float64 {
	billing := a.Router.BillingForModel(candidate.ID).Normalized()
	cost := (billing.InputCreditMultiplier + billing.OutputCreditMultiplier) / 2
	if cost <= 0 || math.IsNaN(cost) || math.IsInf(cost, 0) {
		cost = 1
	}
	return float64(candidate.Priority) -
		(stats.failureRate() * 150) -
		math.Min(stats.avgLatencySeconds(), 30) -
		(cost * 2)
}

func (a *App) recentAutoRouteStats(ctx context.Context) map[string]autoRouteStats {
	records, err := a.Store.AdminLLMCalls(ctx, store.AdminListOptions{Limit: autoRouteStatsLimit})
	if err != nil {
		return nil
	}
	cutoff := time.Now().Add(-autoRouteHealthWindow)
	stats := make(map[string]autoRouteStats)
	for _, record := range records {
		modelID := strings.TrimSpace(record.Mode)
		if modelID == "" || record.StartedAt.Before(cutoff) {
			continue
		}
		item := stats[modelID]
		item.calls += 1
		if record.Status != "done" {
			item.failures += 1
		}
		if !record.FinishedAt.IsZero() && record.FinishedAt.After(record.StartedAt) {
			item.latencySum += record.FinishedAt.Sub(record.StartedAt)
			item.latencies += 1
		}
		stats[modelID] = item
	}
	return stats
}

type autoTaskDifficulty string

const (
	autoDifficultyEasy   autoTaskDifficulty = "easy"
	autoDifficultyMedium autoTaskDifficulty = "medium"
	autoDifficultyHard   autoTaskDifficulty = "hard"
)

func classifyAutoTaskDifficulty(goal string) autoTaskDifficulty {
	goal = strings.TrimSpace(goal)
	if goal == "" {
		return autoDifficultyMedium
	}
	lower := strings.ToLower(goal)
	score := 0
	switch runeLen := len([]rune(goal)); {
	case runeLen > 220:
		score += 2
	case runeLen > 80:
		score += 1
	}
	for _, phrase := range []string{
		"复杂", "深入", "推理", "多步", "架构", "重构", "迁移", "测试", "故障", "错误", "失败",
		"风险", "安全", "审计", "策略", "规划", "性能", "并发", "debug", "bug", "failing",
		"refactor", "architecture", "migration", "security", "performance", "reason", "analyze",
		"implement", "write tests",
	} {
		if strings.Contains(lower, phrase) {
			score += 2
		}
	}
	for _, phrase := range []string{
		"总结", "解释", "翻译", "润色", "改写", "摘要", "列表", "比较", "建议",
		"summarize", "explain", "translate", "rewrite", "compare",
	} {
		if strings.Contains(lower, phrase) {
			score += 1
		}
	}
	for _, phrase := range []string{
		"简单", "一句话", "简短", "快速", "是什么", "怎么读", "拼写", "格式化", "邮件",
		"simple", "brief", "quick", "what is", "spelling", "format", "email",
	} {
		if strings.Contains(lower, phrase) {
			score -= 1
		}
	}
	switch {
	case score >= 3:
		return autoDifficultyHard
	case score >= 1:
		return autoDifficultyMedium
	default:
		return autoDifficultyEasy
	}
}

func autoCandidatesForDifficulty(candidates []modelreg.ChatModelInfo, difficulty autoTaskDifficulty) []modelreg.ChatModelInfo {
	filtered := make([]modelreg.ChatModelInfo, 0, len(candidates))
	for _, candidate := range candidates {
		if autoTierMatchesDifficulty(candidate.CapabilityTier, difficulty) {
			filtered = append(filtered, candidate)
		}
	}
	return filtered
}

func autoCandidatesForIntent(candidates []modelreg.ChatModelInfo, intent AutoResolveIntent) []modelreg.ChatModelInfo {
	filtered := make([]modelreg.ChatModelInfo, 0, len(candidates))
	for _, candidate := range candidates {
		if autoTierMatchesIntent(candidate.CapabilityTier, intent) {
			filtered = append(filtered, candidate)
		}
	}
	return filtered
}

func autoTierMatchesIntent(tier string, intent AutoResolveIntent) bool {
	tier = modelreg.NormalizeCapabilityTier(tier)
	if tier == "" {
		tier = modelreg.CapabilityTierBalanced
	}
	switch intent {
	case AutoResolveIntentFast:
		return tier == modelreg.CapabilityTierFast || tier == modelreg.CapabilityTierBalanced
	case AutoResolveIntentSmart:
		return tier == modelreg.CapabilityTierReasoning || tier == modelreg.CapabilityTierMax
	default:
		return true
	}
}

func autoTierMatchesDifficulty(tier string, difficulty autoTaskDifficulty) bool {
	tier = modelreg.NormalizeCapabilityTier(tier)
	if tier == "" {
		tier = modelreg.CapabilityTierBalanced
	}
	switch difficulty {
	case autoDifficultyEasy:
		return tier == modelreg.CapabilityTierFast || tier == modelreg.CapabilityTierBalanced
	case autoDifficultyHard:
		return tier == modelreg.CapabilityTierReasoning || tier == modelreg.CapabilityTierMax
	default:
		return tier == modelreg.CapabilityTierBalanced || tier == modelreg.CapabilityTierReasoning
	}
}

func autoResolveFallbackReason(intent AutoResolveIntent, difficulty autoTaskDifficulty, goal string) string {
	switch intent {
	case AutoResolveIntentFast:
		return "速度优先"
	case AutoResolveIntentSmart:
		return "能力优先"
	default:
		return autoDifficultyReason(difficulty, goal)
	}
}

func autoDifficultyReason(difficulty autoTaskDifficulty, goal string) string {
	if strings.TrimSpace(goal) == "" {
		return ""
	}
	switch difficulty {
	case autoDifficultyEasy:
		return "简单任务"
	case autoDifficultyHard:
		return "复杂任务"
	default:
		return "中等任务"
	}
}

// buildAutoResolvePrompt lists the catalog candidates (id + label +
// admin-written description, priority order) and asks for a strict JSON pick.
func buildAutoResolvePrompt(candidates []modelreg.ChatModelInfo, difficulty autoTaskDifficulty, intent AutoResolveIntent) string {
	var b strings.Builder
	b.WriteString("你是模型路由器。先参考任务难度,再从候选模型里选择最合适的一个。\n")
	b.WriteString("任务难度: ")
	b.WriteString(string(difficulty))
	if intent != AutoResolveIntentNeutral {
		b.WriteString("\n用户偏好: ")
		b.WriteString(string(intent))
	}
	b.WriteString("\n候选(按稳定性、成本和管理员偏好排序,不确定时选第一个):\n")
	for _, c := range candidates {
		b.WriteString("- id: ")
		b.WriteString(c.ID)
		b.WriteString(" | ")
		b.WriteString(c.Label)
		if c.Vendor != "" {
			b.WriteString(" | vendor: ")
			b.WriteString(c.Vendor)
		}
		if c.CapabilityTier != "" {
			b.WriteString(" | tier: ")
			b.WriteString(c.CapabilityTier)
		}
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
