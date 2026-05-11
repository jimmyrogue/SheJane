package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type OpenAICompatibleProvider struct {
	name    string
	baseURL string
	apiKey  string
	client  *http.Client
}

func NewOpenAICompatibleProvider(name string, baseURL string, apiKey string) *OpenAICompatibleProvider {
	return &OpenAICompatibleProvider{
		name:    name,
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		client:  &http.Client{Timeout: 90 * time.Second},
	}
}

func (p *OpenAICompatibleProvider) Name() string {
	return p.name
}

func (p *OpenAICompatibleProvider) Stream(ctx context.Context, request ChatRequest, model string) (<-chan Chunk, <-chan error) {
	chunks := make(chan Chunk)
	errs := make(chan error, 1)

	go func() {
		defer close(chunks)
		defer close(errs)

		payload := map[string]any{
			"model":          model,
			"messages":       request.Messages,
			"stream":         true,
			"stream_options": map[string]bool{"include_usage": true},
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
			errs <- fmt.Errorf("%s returned status %d", p.name, resp.StatusCode)
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
	payload := map[string]any{
		"model":    model,
		"messages": openAIMessages(request.Messages),
		"stream":   false,
	}
	if len(request.Tools) > 0 {
		payload["tools"] = openAITools(request.Tools)
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
		return Completion{}, fmt.Errorf("%s returned status %d", p.name, resp.StatusCode)
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
			Name:      toolCall.Function.Name,
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
			Content   string `json:"content"`
			ToolCalls []struct {
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

func openAITools(tools []ToolDefinition) []map[string]any {
	result := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		result = append(result, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  tool.InputSchema,
			},
		})
	}
	return result
}

func openAIMessages(messages []Message) []map[string]any {
	result := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		item := map[string]any{
			"role":    message.Role,
			"content": message.Content,
		}
		if message.ToolCallID != "" {
			item["tool_call_id"] = message.ToolCallID
		}
		if message.Name != "" {
			item["name"] = message.Name
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
						"name":      call.Name,
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
