package llm

import (
	"context"
	"strings"
)

type MockProvider struct {
	name  string
	reply string
}

func NewMockProvider(name string, reply string) *MockProvider {
	if reply == "" {
		reply = "Mock Jiandan response"
	}
	return &MockProvider{name: name, reply: reply}
}

func (p *MockProvider) Name() string {
	return p.name
}

func (p *MockProvider) Stream(ctx context.Context, request ChatRequest, model string) (<-chan Chunk, <-chan error) {
	chunks := make(chan Chunk)
	errs := make(chan error, 1)

	go func() {
		defer close(chunks)
		defer close(errs)

		text := p.reply
		if !strings.Contains(text, "Mock Jiandan response") {
			text = text + " | Mock Jiandan response"
		}
		select {
		case <-ctx.Done():
			errs <- ctx.Err()
			return
		case chunks <- Chunk{Text: text, InputTokens: estimateMessagesTokens(request.Messages), OutputTokens: estimateTextTokens(text)}:
		}
	}()

	return chunks, errs
}
