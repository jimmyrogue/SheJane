import { describe, expect, it } from 'vitest'
import { CloudLLMGateway } from './cloudGateway.js'

describe('CloudLLMGateway', () => {
  it('includes cloud API error code and message when the gateway rejects a request', async () => {
    const gateway = new CloudLLMGateway({
      baseURL: 'http://cloud.test',
      accessToken: 'user-token',
      fetcher: async () =>
        new Response(JSON.stringify({ code: 40202, message: '额度不足，请升级或充值', data: null }), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        }),
    })

    await expect(gateway.call({ runId: 'run-1', messages: [{ role: 'user', content: 'hello' }], tools: [] })).rejects.toThrow(
      'Cloud LLM gateway returned HTTP 402 (40202): 额度不足，请升级或充值',
    )
  })
})
