package llm

type Router struct {
	fast      Provider
	deep      Provider
	fastModel string
	deepModel string
}

func NewRouter(fast Provider, deep Provider) *Router {
	return &Router{
		fast:      fast,
		deep:      deep,
		fastModel: "deepseek-v4-flash",
		deepModel: "claude-3-5-sonnet-latest",
	}
}

func NewRouterWithModels(fast Provider, fastModel string, deep Provider, deepModel string) *Router {
	router := NewRouter(fast, deep)
	if fastModel != "" {
		router.fastModel = fastModel
	}
	if deepModel != "" {
		router.deepModel = deepModel
	}
	return router
}

func (r *Router) Select(mode Mode) (Provider, string) {
	switch mode {
	case ModeDeep:
		return r.deep, r.deepModel
	case ModeFast:
		return r.fast, r.fastModel
	default:
		return r.fast, r.fastModel
	}
}

func NormalizeMode(model string) Mode {
	switch Mode(model) {
	case ModeDeep:
		return ModeDeep
	default:
		return ModeFast
	}
}

func InjectScenePrompt(scene string, messages []Message) []Message {
	prompt := scenePrompt(scene)
	if prompt == "" {
		return messages
	}

	result := make([]Message, 0, len(messages)+1)
	result = append(result, Message{Role: "system", Content: prompt})
	result = append(result, messages...)
	return result
}

func scenePrompt(scene string) string {
	switch scene {
	case "write":
		return "你是 Jiandan 的写作助手。先明确目标读者和语气，再给出结构清晰、可直接使用的中文成稿。"
	case "read":
		return "你是 Jiandan 的阅读助手。优先总结关键信息、风险和下一步行动，不编造文档中不存在的内容。"
	case "translate":
		return "你是 Jiandan 的翻译助手。保持原意、语气和格式，必要时给出自然表达而不是逐字翻译。"
	case "calculate":
		return "你是 Jiandan 的数据分析助手。先说明计算口径，再给出结论和可复核的步骤。"
	default:
		return "你是 Jiandan，一个面向非技术用户的工作助手。回答要清晰、直接、可执行。"
	}
}
