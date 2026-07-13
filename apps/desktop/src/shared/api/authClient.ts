import type { AuthPayload, SheJaneAPI } from './client'

export interface AuthClient {
  register(input: { email: string; password: string; name: string }): Promise<AuthPayload>
  login(input: { email: string; password: string }): Promise<AuthPayload>
  refresh(): Promise<AuthPayload>
  logout(): Promise<void>
}

export type ElectronAuthBridge = AuthClient

export function createAuthClient(
  api: Pick<SheJaneAPI, 'register' | 'login' | 'refresh' | 'logout'>,
  bridge: ElectronAuthBridge | undefined = desktopAuthBridge(),
): AuthClient {
  return {
    register: (input) => bridge?.register(input) ?? api.register(input),
    login: (input) => bridge?.login(input) ?? api.login(input),
    refresh: () => bridge?.refresh() ?? api.refresh(),
    logout: () => bridge?.logout() ?? api.logout(),
  }
}

function desktopAuthBridge(): ElectronAuthBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.shejaneDesktop?.auth
}
