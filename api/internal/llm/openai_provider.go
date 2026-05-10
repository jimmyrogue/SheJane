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
