-- Short vendor blurbs shown in the user model picker info tooltip.
-- Stored per model row so admins can tune vendor copy without a client deploy.

ALTER TABLE model_configs
    ADD COLUMN IF NOT EXISTS vendor_info TEXT NOT NULL DEFAULT '';

UPDATE model_configs
SET vendor_info = CASE lower(vendor)
    WHEN 'deepseek' THEN '深度求索，推理能力与性价比突出。'
    WHEN 'xiaomi' THEN '小米模型，适合快速问答与编码辅助。'
    WHEN 'chatgpt' THEN 'OpenAI 出品，通用能力全面。'
    WHEN 'openai' THEN 'OpenAI 出品，通用能力全面。'
    WHEN 'claude' THEN 'Anthropic 出品，擅长写作、代码与长文理解。'
    WHEN 'anthropic' THEN 'Anthropic 出品，擅长写作、代码与长文理解。'
    WHEN 'minimax' THEN 'MiniMax 出品，适合长上下文和 Agent 任务。'
    WHEN 'kimi' THEN '月之暗面，擅长长上下文与长文档。'
    WHEN 'qwen' THEN '阿里通义千问，中文与多语言表现出色。'
    WHEN 'gemini' THEN 'Google 出品，原生多模态能力突出。'
    ELSE vendor_info
END
WHERE vendor_info = '';
