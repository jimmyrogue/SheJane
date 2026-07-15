import { describe, expect, it } from 'vitest'

import {
  createLocalSkill,
  createMcpServer,
  deleteLocalModelProvider,
  deleteLocalSkill,
  deleteMcpServer,
  getLocalRuntimeInfo,
  getLocalSkillFile,
  getRuntimeSettings,
  listInstalledSkills,
  listLocalModelProviders,
  listLocalRuntimeModels,
  listMcpServers,
  updateLocalSkill,
  updateMcpServer,
  updateRuntimeSettings,
  upsertLocalModelProvider,
} from './client'

const BASE_URL = process.env.VITE_TEST_LOCAL_HOST_URL
const TOKEN = process.env.VITE_TEST_LOCAL_HOST_TOKEN ?? 'dev-local-token'

describe.skipIf(!BASE_URL)('contract: Runtime catalogs (live daemon)', () => {
  const config = { baseURL: BASE_URL!, token: TOKEN }

  it('authenticates Runtime discovery and rejects a wrong token', async () => {
    const info = await getLocalRuntimeInfo(config)
    expect(info.protocol_version).toBe(1)
    expect(info.runtime_version).toMatch(/^\d+\.\d+\.\d+/)
    expect(info.capabilities).toEqual(expect.arrayContaining(['agent.run', 'agent.stream']))

    const rejected = await fetch(`${BASE_URL}/local/v1/runtime`, {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(rejected.status).toBe(401)
  })

  it('persists Runtime settings through the public interface', async () => {
    const original = await getRuntimeSettings(config)
    const nextCalls = original.max_model_calls === 7 ? 8 : 7
    try {
      const updated = await updateRuntimeSettings({
        max_model_calls: nextCalls,
        plan_first: 'auto',
      }, config)
      expect(updated.max_model_calls).toBe(nextCalls)
      expect(updated.plan_first).toBe('auto')
      expect(updated.version).toBeGreaterThan(original.version)

      await expect(getRuntimeSettings(config)).resolves.toMatchObject({
        max_model_calls: nextCalls,
        plan_first: 'auto',
      })
    } finally {
      await updateRuntimeSettings({
        max_model_calls: original.max_model_calls,
        plan_first: original.plan_first,
      }, config)
    }
  })

  it('publishes the built-in tool catalog', async () => {
    const response = await fetch(`${BASE_URL}/local/v1/tools`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { tools: Array<{ name: string }> }
    const names = body.tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'read_file',
      'write_file',
      'execute',
      'time.now',
      'task.verify',
    ]))
  })

  it('creates, lists, exposes, and deletes a no-key model provider', async () => {
    const providerID = 'e2e-provider'
    await deleteLocalModelProvider(providerID, config).catch(() => undefined)
    try {
      const saved = await upsertLocalModelProvider(providerID, {
        name: 'E2E Provider',
        kind: 'openai_compatible',
        base_url: 'http://127.0.0.1:9/v1',
        requires_api_key: false,
        models: [{
          model_id: 'e2e-model',
          display_name: 'E2E Model',
          tool_calling: true,
          streaming: true,
          image_inputs: true,
        }],
        enabled: true,
      }, config)
      expect(saved).toMatchObject({ id: providerID, credential_configured: true })

      const providers = await listLocalModelProviders(config)
      expect(providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: providerID, name: 'E2E Provider' }),
      ]))
      const models = await listLocalRuntimeModels(config)
      expect(models).toEqual(expect.arrayContaining([
        expect.objectContaining({
          spec: `local:${providerID}:e2e-model`,
          available: true,
          image_inputs: true,
        }),
      ]))
    } finally {
      await deleteLocalModelProvider(providerID, config).catch(() => undefined)
    }
    expect((await listLocalModelProviders(config)).some((item) => item.id === providerID)).toBe(false)
  })

  it('manages a Skill inside the isolated Runtime Skill root', async () => {
    const name = 'e2e-skill'
    await deleteLocalSkill(name, config).catch(() => undefined)
    try {
      await createLocalSkill({
        name,
        description: 'E2E Skill',
        content: '# E2E Skill\n\nReturn a deterministic result.',
      }, config)
      await expect(getLocalSkillFile(name, config)).resolves.toMatchObject({
        name,
        content: expect.stringContaining('deterministic result'),
      })
      await updateLocalSkill(name, {
        name,
        description: 'Updated E2E Skill',
        content: '# Updated E2E Skill',
      }, config)
      const catalog = await listInstalledSkills(config)
      expect(catalog.skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ name }),
      ]))
    } finally {
      await deleteLocalSkill(name, config).catch(() => undefined)
    }
    expect((await listInstalledSkills(config)).skills.some((item) => item.name === name)).toBe(false)
  })

  it('manages Runtime-owned MCP configuration without exposing secret values', async () => {
    const name = 'e2e-mcp'
    const args = ['run', 'python', 'tests/fixtures/e2e_mcp_server.py']
    await deleteMcpServer(name, config).catch(() => undefined)
    try {
      const created = await createMcpServer({
        name,
        transport: 'stdio',
        command: 'uv',
        args,
        env: { E2E_SECRET: 'not-a-real-secret' },
      }, config)
      expect(created.server).toMatchObject({ name, env_keys: ['E2E_SECRET'] })
      expect(JSON.stringify(created)).not.toContain('not-a-real-secret')

      const updated = await updateMcpServer(name, {
        name,
        transport: 'stdio',
        command: 'uv',
        args,
        env: {},
      }, config)
      expect(updated.server).toMatchObject({ args, env_keys: [] })
      expect((await listMcpServers(config)).servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name, args }),
      ]))
    } finally {
      await deleteMcpServer(name, config).catch(() => undefined)
    }
    expect((await listMcpServers(config)).servers.some((item) => item.name === name)).toBe(false)
  })
})
