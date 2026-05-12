package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const providerErrorBodyLimit = 4096

type OpenAICompatibleProvider struct {
	name    string
	baseURL string
	apiKey  string
	client  *http.Client
	profile ProviderProfile
}

func NewOpenAICompatibleProvider(name string, baseURL string, apiKey string) *OpenAICompatibleProvider {
	return NewOpenAICompatibleProviderWithProfile(name, baseURL, apiKey, ProfileForProviderKind(InferOpenAIProviderKind("", baseURL)))
}

func NewOpenAICompatibleProviderWithProfile(name string, baseURL string, apiKey string, profile ProviderProfile) *OpenAICompatibleProvider {
	if profile.Kind == "" {
		profile = OpenAICompatibleProfile()
	}
	return &OpenAICompatibleProvider{
		name:    name,
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		client:  &http.Client{Timeout: 90 * time.Second},
		profile: profile,
	}
}

func (p *OpenAICompatibleProvider) Name() string {
	return p.name
}

func (p *OpenAICompatibleProvider) ProviderKind() ProviderKind {
	return p.profile.Kind
}

func (p *OpenAICompatibleProvider) Stream(ctx context.Context, request ChatRequest, model string) (<-chan Chunk, <-chan error) {
	chunks := make(chan Chunk)
	errs := make(chan error, 1)

	go func() {
		defer close(chunks)
		defer close(errs)

		payload := map[string]any{
			"model":    model,
			"messages": openAIMessages(request.Messages, nil, p.profile),
			"stream":   true,
		}
		if p.profile.IncludeStreamUsage {
			payload["stream_options"] = map[string]bool{"include_usage": true}
		}
		body, err := json.Marshal(payload)
		if err != nil {
			errs <- err
			return
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(body))
		if err != nil {
			errs <- err
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if p.apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+p.apiKey)
		}

		resp, err := p.client.Do(req)
		if err != nil {
			errs <- err
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 300 {
			errs <- providerStatusError(p.name, resp.StatusCode, resp.Body)
			return
		}

		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "[DONE]" {
				return
			}
			var event openAIStreamEvent
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				errs <- err
				return
			}
			hasUsage := event.Usage.PromptTokens > 0 || event.Usage.CompletionTokens > 0
			if len(event.Choices) == 0 && hasUsage {
				chunks <- Chunk{
					InputTokens:  event.Usage.PromptTokens,
					OutputTokens: event.Usage.CompletionTokens,
				}
				continue
			}
			for _, choice := range event.Choices {
				if choice.Delta.Content != "" || choice.FinishReason != "" {
					chunks <- Chunk{
						Text:         choice.Delta.Content,
						InputTokens:  event.Usage.PromptTokens,
						OutputTokens: event.Usage.CompletionTokens,
						FinishReason: choice.FinishReason,
					}
				}
			}
		}
		if err := scanner.Err(); err != nil {
			errs <- err
		}
	}()

	return chunks, errs
}

func (p *OpenAICompatibleProvider) CompleteWithTools(ctx context.Context, request ChatRequest, model string) (Completion, error) {
	toolNames, reverseToolNames := openAIToolNameMaps(request.Tools)
	payload := map[string]any{
		"model":    model,
		"messages": openAIMessages(request.Messages, toolNames, p.profile),
		"stream":   false,
	}
	if p.profile.SupportsThinking && p.profile.ThinkingType != "" {
		payload["thinking"] = map[string]string{"type": p.profile.ThinkingType}
	}
	if p.profile.AgentReasoningEffort != "" {
		payload["reasoning_effort"] = p.profile.AgentReasoningEffort
	}
	if len(request.Tools) > 0 {
		payload["tools"] = openAITools(request.Tools, toolNames)
		payload["tool_choice"] = "auto"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Completion{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Completion{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return Completion{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return Completion{}, providerStatusError(p.name, resp.StatusCode, resp.Body)
	}
	var event openAICompletionEvent
	if err := json.NewDecoder(resp.Body).Decode(&event); err != nil {
		return Completion{}, err
	}
	completion := Completion{
		InputTokens:  event.Usage.PromptTokens,
		OutputTokens: event.Usage.CompletionTokens,
	}
	if len(event.Choices) == 0 {
		return completion, nil
	}
	choice := event.Choices[0]
	completion.Content = choice.Message.Content
	completion.ReasoningContent = choice.Message.ReasoningContent
	completion.FinishReason = choice.FinishReason
	for _, toolCall := range choice.Message.ToolCalls {
		arguments := map[string]any{}
		if strings.TrimSpace(toolCall.Function.Arguments) != "" {
			if err := json.Unmarshal([]byte(toolCall.Function.Arguments), &arguments); err != nil {
				return Completion{}, err
			}
		}
		completion.ToolCalls = append(completion.ToolCalls, ToolCall{
			ID:        toolCall.ID,
			Name:      reverseToolName(toolCall.Function.Name, reverseToolNames),
			Arguments: arguments,
		})
	}
	return completion, nil
}

type openAIStreamEvent struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

type openAICompletionEvent struct {
	Choices []struct {
		Message struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
			ToolCalls        []struct {
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

func providerStatusError(provider string, status int, body io.Reader) error {
	if body == nil {
		return fmt.Errorf("%s returned status %d", provider, status)
	}
	data, err := io.ReadAll(io.LimitReader(body, providerErrorBodyLimit+1))
	if err != nil {
		return fmt.Errorf("%s returned status %d", provider, status)
	}
	snippet := strings.TrimSpace(string(data))
	if snippet == "" {
		return fmt.Errorf("%s returned status %d", provider, status)
	}
	truncated := len(data) > providerErrorBodyLimit
	if truncated {
		snippet = strings.TrimSpace(string(data[:providerErrorBodyLimit]))
	}
	snippet = strings.Join(strings.Fields(snippet), " ")
	if truncated {
		snippet += "..."
	}
	return fmt.Errorf("%s returned status %d: %s", provider, status, snippet)
}

func openAITools(tools []ToolDefinition, names map[string]string) []map[string]any {
	result := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		result = append(result, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        forwardToolName(tool.Name, names),
				"description": tool.Description,
				"parameters":  tool.InputSchema,
			},
		})
	}
	return result
}

func openAIMessages(messages []Message, toolNames map[string]string, profile ProviderProfile) []map[string]any {
	result := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		item := map[string]any{
			"role":    message.Role,
			"content": message.Content,
		}
		if message.ToolCallID != "" {
			item["tool_call_id"] = message.ToolCallID
		}
		if message.Name != "" && (message.Role != "tool" || profile.AllowToolMessageName) {
			item["name"] = forwardToolName(message.Name, toolNames)
		}
		if message.Role == "assistant" && profile.SupportsThinking && message.ReasoningContent != "" {
			item["reasoning_content"] = message.ReasoningContent
		}
		if len(message.ToolCalls) > 0 {
			calls := make([]map[string]any, 0, len(message.ToolCalls))
			for _, call := range message.ToolCalls {
				arguments, err := json.Marshal(call.Arguments)
				if err != nil {
					arguments = []byte("{}")
				}
				calls = append(calls, map[string]any{
					"id":   call.ID,
					"type": "function",
					"function": map[string]any{
						"name":      forwardToolName(call.Name, toolNames),
						"arguments": string(arguments),
					},
				})
			}
			item["tool_calls"] = calls
		}
		result = append(result, item)
	}
	return result
}

func openAIToolNameMaps(tools []ToolDefinition) (map[string]string, map[string]string) {
	forward := make(map[string]string, len(tools))
	reverse := make(map[string]string, len(tools))
	used := make(map[string]int, len(tools))
	for _, tool := range tools {
		if strings.TrimSpace(tool.Name) == "" {
			continue
		}
		name := providerSafeToolName(tool.Name, used)
		forward[tool.Name] = name
		reverse[name] = tool.Name
	}
	return forward, reverse
}

func providerSafeToolName(name string, used map[string]int) string {
	var builder strings.Builder
	for _, r := range strings.TrimSpace(name) {
		switch {
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			builder.WriteRune(r)
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
		case r == '_' || r == '-':
			builder.WriteRune(r)
		case r == '.':
			builder.WriteString("__")
		default:
			builder.WriteRune('_')
		}
	}
	base := builder.String()
	if base == "" {
		base = "tool"
	}
	if len(base) > 64 {
		base = base[:64]
	}
	candidate := base
	if count := used[candidate]; count > 0 {
		for {
			suffix := fmt.Sprintf("__%d", count+1)
			prefix := base
			if len(prefix)+len(suffix) > 64 {
				prefix = prefix[:64-len(suffix)]
			}
			candidate = prefix + suffix
			if used[candidate] == 0 {
				break
			}
			count++
		}
	}
	used[candidate]++
	return candidate
}

func forwardToolName(name string, names map[string]string) string {
	if mapped := names[name]; mapped != "" {
		return mapped
	}
	return name
}

func reverseToolName(name string, names map[string]string) string {
	if mapped := names[name]; mapped != "" {
		return mapped
	}
	return name
}
