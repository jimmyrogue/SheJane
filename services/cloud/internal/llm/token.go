package llm

import (
	"encoding/json"
	"fmt"
)

func EstimateTokens(messages []Message) int {
	return estimateMessagesTokens(messages)
}

func EstimateRequestTokens(request ChatRequest) int {
	total := messageRuneCount(request.Messages)
	total += len([]rune(request.Model))
	total += len([]rune(request.Scene))
	for _, tool := range request.Tools {
		total += 16
		total += len([]rune(tool.Name))
		total += len([]rune(tool.Description))
		total += encodedValueRuneCount(tool.InputSchema)
	}
	return estimateRuneTokens(total)
}

func estimateMessagesTokens(messages []Message) int {
	return estimateRuneTokens(messageRuneCount(messages))
}

func messageRuneCount(messages []Message) int {
	total := 0
	for _, message := range messages {
		total += 12
		total += len([]rune(message.Role))
		total += len([]rune(message.Content))
		total += len([]rune(message.ReasoningContent))
		total += len([]rune(message.ToolCallID))
		total += len([]rune(message.Name))
		for _, call := range message.ToolCalls {
			total += 8
			total += len([]rune(call.ID))
			total += len([]rune(call.Name))
			total += encodedValueRuneCount(call.Arguments)
		}
	}
	return total
}

func encodedValueRuneCount(value any) int {
	if value == nil {
		return 0
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return len([]rune(fmt.Sprint(value)))
	}
	return len([]rune(string(raw)))
}

func estimateRuneTokens(runes int) int {
	estimate := runes / 4
	if estimate < 1 {
		return 1
	}
	return estimate
}

func estimateTextTokens(text string) int {
	return estimateRuneTokens(len([]rune(text)))
}
