import { CloudLLMGateway } from './cloudGateway.js'
import type { LLMGateway } from './gateway.js'

export interface CloudSessionInput {
  cloudBaseURL?: string
  accessToken: string
}

export interface CloudSessionState {
  connected: boolean
  cloud_base_url?: string
  auth?: 'bearer'
  updated_at?: string
}

interface StoredCloudSession {
  cloudBaseURL: string
  accessToken: string
  updatedAt: string
}

export class LocalCloudSessionManager {
  private session?: StoredCloudSession

  constructor(
    private readonly options: {
      defaultBaseURL?: string
      fetcher?: typeof fetch
    } = {},
  ) {}

  setSession(input: CloudSessionInput): CloudSessionState {
    const cloudBaseURL = normalizeCloudBaseURL(input.cloudBaseURL || this.options.defaultBaseURL || '')
    const accessToken = input.accessToken.trim()
    if (!cloudBaseURL) {
      throw new Error('cloud_base_url_required')
    }
    if (!accessToken) {
      throw new Error('access_token_required')
    }
    this.session = {
      cloudBaseURL,
      accessToken,
      updatedAt: new Date().toISOString(),
    }
    return this.state()
  }

  clearSession(): CloudSessionState {
    this.session = undefined
    return this.state()
  }

  state(): CloudSessionState {
    if (!this.session) {
      return { connected: false }
    }
    return {
      connected: true,
      cloud_base_url: this.session.cloudBaseURL,
      auth: 'bearer',
      updated_at: this.session.updatedAt,
    }
  }

  gateway(): LLMGateway | undefined {
    if (!this.session) {
      return undefined
    }
    return new CloudLLMGateway({
      baseURL: this.session.cloudBaseURL,
      accessToken: this.session.accessToken,
      fetcher: this.options.fetcher,
    })
  }
}

function normalizeCloudBaseURL(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '')
  if (!trimmed) {
    return ''
  }
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('cloud_base_url_invalid')
  }
  return parsed.toString().replace(/\/$/, '')
}
