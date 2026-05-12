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

type AnthropicProvider struct {
	apiKey  string
	version string
	client  *http.Client
}

func NewAnthropicProvider(apiKey string, version string) *AnthropicProvider {
	if version == "" {
		version = "2023-06-01"
	}
	return &AnthropicProvider{
		apiKey:  apiKey,
		version: version,
		client:  &http.Client{Timeout: 90 * time.Second},
	}
}

func (p *AnthropicProvider) Name() string {
	return "anthropic-claude"
}

func (p *AnthropicProvider) ProviderKind() ProviderKind {
	return ProviderKindAnthropic
}

func (p *AnthropicProvider) Stream(ctx context.Context, request ChatRequest, model string) (<-chan Chunk, <-chan error) {
	chunks := make(chan Chunk)
	errs := make(chan error, 1)

	go func() {
		defer close(chunks)
		defer close(errs)

		system, messages := splitSystemMessage(request.Messages)
		payload := map[string]any{
			"model":      model,
			"max_tokens": 2048,
			"messages":   messages,
			"stream":     true,
		}
		if system != "" {
			payload["system"] = system
		}
		body, err := json.Marshal(payload)
		if err != nil {
			errs <- err
			return
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(body))
		if err != nil {
			errs <- err
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-api-key", p.apiKey)
		req.Header.Set("anthropic-version", p.version)

		resp, err := p.client.Do(req)
		if err != nil {
			errs <- err
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 300 {
			errs <- fmt.Errorf("anthropic returned status %d", resp.StatusCode)
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
			case "content_block_delta":
				chunks <- Chunk{Text: event.Delta.Text, OutputTokens: event.Usage.OutputTokens}
			case "message_delta":
				if event.Delta.StopReason != "" {
					chunks <- Chunk{FinishReason: event.Delta.StopReason, OutputTokens: event.Usage.OutputTokens}
				}
			}
		}
		if err := scanner.Err(); err != nil {
			errs <- err
		}
	}()

	return chunks, errs
}

type anthropicStreamEvent struct {
	Type  string `json:"type"`
	Delta struct {
		Text       string `json:"text"`
		StopReason string `json:"stop_reason"`
	} `json:"delta"`
	Usage struct {
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

func splitSystemMessage(messages []Message) (string, []Message) {
	if len(messages) == 0 || messages[0].Role != "system" {
		return "", messages
	}
	return messages[0].Content, messages[1:]
}
