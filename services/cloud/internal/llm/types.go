package llm

import "context"

type Message struct {
	Role             string     `json:"role"`
	Content          string     `json:"content"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	ToolCallID       string     `json:"tool_call_id,omitempty"`
	Name             string     `json:"name,omitempty"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
}

type ChatRequest struct {
	Model                string           `json:"model"`
	Messages             []Message        `json:"messages"`
	Tools                []ToolDefinition `json:"tools,omitempty"`
	Stream               bool             `json:"stream"`
	ClientConversationID string           `json:"client_conversation_id"`
	ClientMessageID      string           `json:"client_message_id"`
	Scene                string           `json:"scene"`
	OrganizationID       string           `json:"organization_id,omitempty"`
	MaxOutputTokens      int              `json:"max_output_tokens,omitempty"`
}

type ToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

type ToolCall struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

type Completion struct {
	Content          string
	ReasoningContent string
	ToolCalls        []ToolCall
	InputTokens      int
	OutputTokens     int
	FinishReason     string
}

type Chunk struct {
	Text             string
	ReasoningContent string
	InputTokens      int
	OutputTokens     int
	FinishReason     string
}

type Provider interface {
	Name() string
	Stream(ctx context.Context, request ChatRequest, model string) (<-chan Chunk, <-chan error)
}
