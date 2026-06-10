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
		reply = "Mock SheJane response"
	}
	return &MockProvider{name: name, reply: reply}
}

func (p *MockProvider) Name() string {
	return p.name
}

func (p *MockProvider) ProviderKind() ProviderKind {
	return ProviderKindMock
}

// CompleteWithTools satisfies the agentToolCompleter contract so the mock kind
// counts as tool-capable (the catalog only admits tool-capable models). It
// answers with the canned reply and never requests a tool — tool-calling
// roundtrips are exercised against fake HTTP providers in tests instead.
func (p *MockProvider) CompleteWithTools(ctx context.Context, request ChatRequest, _ string) (Completion, error) {
	if err := ctx.Err(); err != nil {
		return Completion{}, err
	}
	text := p.reply
	if !strings.Contains(text, "Mock SheJane response") {
		text = text + " | Mock SheJane response"
	}
	return Completion{
		Content:      text,
		FinishReason: "stop",
		InputTokens:  estimateMessagesTokens(request.Messages),
		OutputTokens: estimateTextTokens(text),
	}, nil
}

func (p *MockProvider) Stream(ctx context.Context, request ChatRequest, model string) (<-chan Chunk, <-chan error) {
	chunks := make(chan Chunk)
	errs := make(chan error, 1)

	go func() {
		defer close(chunks)
		defer close(errs)

		text := p.reply
		if !strings.Contains(text, "Mock SheJane response") {
			text = text + " | Mock SheJane response"
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
