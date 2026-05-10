package llm

func EstimateTokens(messages []Message) int {
	return estimateMessagesTokens(messages)
}

func estimateMessagesTokens(messages []Message) int {
	total := 0
	for _, message := range messages {
		total += len([]rune(message.Role))
		total += len([]rune(message.Content))
	}
	estimate := total / 4
	if estimate < 1 {
		return 1
	}
	return estimate
}

func estimateTextTokens(text string) int {
	estimate := len([]rune(text)) / 4
	if estimate < 1 {
		return 1
	}
	return estimate
}
