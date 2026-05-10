package llm

import "context"

type Mode string

const (
	ModeFast Mode = "fast"
	ModeDeep Mode = "deep"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model                string    `json:"model"`
	Messages             []Message `json:"messages"`
	Stream               bool      `json:"stream"`
	ClientConversationID string    `json:"client_conversation_id"`
	ClientMessageID      string    `json:"client_message_id"`
	Scene                string    `json:"scene"`
	OrganizationID       string    `json:"organization_id,omitempty"`
}

type Chunk struct {
	Text         string
	InputTokens  int
	OutputTokens int
	FinishReason string
}

type Provider interface {
	Name() string
	Stream(ctx context.Context, request ChatRequest, model string) (<-chan Chunk, <-chan error)
}
