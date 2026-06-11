package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

const (
	defaultAnthropicBaseURL = "https://api.anthropic.com"
	// defaultAnthropicMaxTokens is the response cap when the model row doesn't
	// configure one. 8192 is supported by every Claude 3.5+ model; the old
	// hardcoded 2048 truncated long agent answers mid-sentence.
	defaultAnthropicMaxTokens = 8192
	// Anthropic's prompt cache silently skips prompts below the model/platform
	// threshold; 1024 is the lowest documented minimum for active Claude models.
	anthropicPromptCacheMinEstimateTokens = 1024
)

type AnthropicProvider struct {
	apiKey    string
	version   string
	baseURL   string
	maxTokens int
	client    *http.Client
}

func NewAnthropicProvider(apiKey string, version string) *AnthropicProvider {
	return NewAnthropicProviderWithConfig(apiKey, version, "", 0)
}

// NewAnthropicProviderWithConfig allows the model registry to plumb per-row
// settings: baseURL (proxy/gateway deployments) and maxTokens (response cap).
// Zero values fall back to the package defaults.
func NewAnthropicProviderWithConfig(apiKey, version, baseURL string, maxTokens int) *AnthropicProvider {
	if version == "" {
		version = "2023-06-01"
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultAnthropicBaseURL
	}
	if maxTokens <= 0 {
		maxTokens = defaultAnthropicMaxTokens
	}
	return &AnthropicProvider{
		apiKey:    apiKey,
		version:   version,
		baseURL:   strings.TrimRight(baseURL, "/"),
		maxTokens: maxTokens,
		client:    &http.Client{Timeout: 90 * time.Second},
	}
}

func (p *AnthropicProvider) Name() string {
	return "anthropic-claude"
}

func (p *AnthropicProvider) ProviderKind() ProviderKind {
	return ProviderKindAnthropic
}

func (p *AnthropicProvider) newRequest(ctx context.Context, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", p.apiKey)
	req.Header.Set("anthropic-version", p.version)
	return req, nil
}

func (p *AnthropicProvider) Stream(ctx context.Context, request ChatRequest, model string) (<-chan Chunk, <-chan error) {
	chunks := make(chan Chunk)
	errs := make(chan error, 1)

	go func() {
		defer close(chunks)
		defer close(errs)

		system, history := splitSystemMessage(request.Messages)
		payload := map[string]any{
			"model":      model,
			"max_tokens": p.maxTokens,
			"messages":   anthropicMessages(history, nil),
			"stream":     true,
		}
		if system != "" {
			payload["system"] = system
		}
		enableAnthropicPromptCaching(payload, request)
		body, err := json.Marshal(payload)
		if err != nil {
			errs <- err
			return
		}

		req, err := p.newRequest(ctx, body)
		if err != nil {
			errs <- err
			return
		}

		resp, err := p.client.Do(req)
		if err != nil {
			errs <- err
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 300 {
			errs <- providerStatusError(p.Name(), resp.StatusCode, resp.Body)
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
			var event anthropicStreamEvent
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				errs <- err
				return
			}
			switch event.Type {
			case "message_start":
				// Anthropic reports input tokens once, up front. Surfacing them
				// here lets billing settle on real usage instead of the crude
				// length/4 estimate.
				if event.Message.Usage.InputTokens > 0 {
					chunks <- Chunk{InputTokens: event.Message.Usage.InputTokens}
				}
			case "content_block_delta":
				chunks <- Chunk{Text: event.Delta.Text, OutputTokens: event.Usage.OutputTokens}
			case "message_delta":
				if event.Delta.StopReason != "" {
					chunks <- Chunk{
						FinishReason: anthropicFinishReason(event.Delta.StopReason),
						OutputTokens: event.Usage.OutputTokens,
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

// CompleteWithTools is the non-streaming tool-calling turn (the same
// agentToolCompleter contract the OpenAI-compatible provider implements).
// Tool names are sanitized to Anthropic's [a-zA-Z0-9_-] charset on the way
// out (e.g. web.search → web__search) and mapped back on the way in, and
// stop_reason is normalized to the OpenAI-style finish_reason vocabulary
// ("tool_calls"/"stop"/"length") the daemon and web loop already speak.
func (p *AnthropicProvider) CompleteWithTools(ctx context.Context, request ChatRequest, model string) (Completion, error) {
	toolNames, reverseToolNames := openAIToolNameMaps(request.Tools)
	system, history := splitSystemMessage(request.Messages)
	payload := map[string]any{
		"model":      model,
		"max_tokens": p.maxTokens,
		"messages":   anthropicMessages(history, toolNames),
		"stream":     false,
	}
	if system != "" {
		payload["system"] = system
	}
	if len(request.Tools) > 0 {
		tools := make([]map[string]any, 0, len(request.Tools))
		for _, tool := range request.Tools {
			schema := tool.InputSchema
			if schema == nil {
				schema = map[string]any{"type": "object"}
			}
			tools = append(tools, map[string]any{
				"name":         forwardToolName(tool.Name, toolNames),
				"description":  tool.Description,
				"input_schema": schema,
			})
		}
		payload["tools"] = tools
		payload["tool_choice"] = map[string]any{"type": "auto"}
	}
	enableAnthropicPromptCaching(payload, request)
	body, err := json.Marshal(payload)
	if err != nil {
		return Completion{}, err
	}
	req, err := p.newRequest(ctx, body)
	if err != nil {
		return Completion{}, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return Completion{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return Completion{}, providerStatusError(p.Name(), resp.StatusCode, resp.Body)
	}
	var event anthropicCompletionResponse
	if err := json.NewDecoder(resp.Body).Decode(&event); err != nil {
		return Completion{}, err
	}
	completion := Completion{
		InputTokens:  event.Usage.InputTokens,
		OutputTokens: event.Usage.OutputTokens,
		FinishReason: anthropicFinishReason(event.StopReason),
	}
	var text strings.Builder
	for _, block := range event.Content {
		switch block.Type {
		case "text":
			text.WriteString(block.Text)
		case "tool_use":
			arguments := map[string]any{}
			if len(block.Input) > 0 {
				if err := json.Unmarshal(block.Input, &arguments); err != nil {
					return Completion{}, err
				}
			}
			completion.ToolCalls = append(completion.ToolCalls, ToolCall{
				ID:        block.ID,
				Name:      reverseToolName(block.Name, reverseToolNames),
				Arguments: arguments,
			})
		}
	}
	completion.Content = text.String()
	return completion, nil
}

func enableAnthropicPromptCaching(payload map[string]any, request ChatRequest) {
	if EstimateRequestTokens(request) < anthropicPromptCacheMinEstimateTokens {
		return
	}
	payload["cache_control"] = map[string]string{"type": "ephemeral"}
}

// anthropicMessages converts the neutral message history to Anthropic content
// blocks: assistant tool calls become tool_use blocks, `tool` results become
// user tool_result blocks, and consecutive same-role messages are merged
// (the Messages API requires alternating user/assistant turns).
func anthropicMessages(messages []Message, toolNames map[string]string) []map[string]any {
	result := make([]map[string]any, 0, len(messages))
	appendBlocks := func(role string, blocks []map[string]any) {
		if len(blocks) == 0 {
			return
		}
		if len(result) > 0 && result[len(result)-1]["role"] == role {
			prev := result[len(result)-1]["content"].([]map[string]any)
			result[len(result)-1]["content"] = append(prev, blocks...)
			return
		}
		result = append(result, map[string]any{"role": role, "content": blocks})
	}
	for _, message := range messages {
		switch message.Role {
		case "tool":
			block := map[string]any{
				"type":        "tool_result",
				"tool_use_id": message.ToolCallID,
				"content":     message.Content,
			}
			appendBlocks("user", []map[string]any{block})
		case "assistant":
			blocks := make([]map[string]any, 0, 1+len(message.ToolCalls))
			if message.Content != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": message.Content})
			}
			for _, call := range message.ToolCalls {
				input := call.Arguments
				if input == nil {
					input = map[string]any{}
				}
				blocks = append(blocks, map[string]any{
					"type":  "tool_use",
					"id":    call.ID,
					"name":  forwardToolName(call.Name, toolNames),
					"input": input,
				})
			}
			appendBlocks("assistant", blocks)
		default: // user (and anything unknown defaults to user)
			if message.Content == "" {
				continue
			}
			appendBlocks("user", []map[string]any{{"type": "text", "text": message.Content}})
		}
	}
	return result
}

// anthropicFinishReason maps Anthropic stop_reason values onto the OpenAI-style
// finish_reason vocabulary the rest of the stack (daemon loop, web loop,
// agent_stream events) is written against.
func anthropicFinishReason(stopReason string) string {
	switch stopReason {
	case "tool_use":
		return "tool_calls"
	case "end_turn", "stop_sequence":
		return "stop"
	case "max_tokens":
		return "length"
	default:
		return stopReason
	}
}

type anthropicStreamEvent struct {
	Type    string `json:"type"`
	Message struct {
		Usage struct {
			InputTokens int `json:"input_tokens"`
		} `json:"usage"`
	} `json:"message"`
	Delta struct {
		Text       string `json:"text"`
		StopReason string `json:"stop_reason"`
	} `json:"delta"`
	Usage struct {
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

type anthropicCompletionResponse struct {
	Content []struct {
		Type  string          `json:"type"`
		Text  string          `json:"text"`
		ID    string          `json:"id"`
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

func splitSystemMessage(messages []Message) (string, []Message) {
	if len(messages) == 0 || messages[0].Role != "system" {
		return "", messages
	}
	return messages[0].Content, messages[1:]
}
