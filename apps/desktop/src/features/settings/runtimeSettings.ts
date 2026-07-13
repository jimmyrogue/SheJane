import type {
  AdvancedAgentSettings,
  RuntimeSettings,
  UpdateRuntimeSettingsRequest,
} from '@/shared/local-host/client'

const runtimeDefaults = {
  maxModelCalls: 20,
  maxToolRetries: 2,
  researchSearchLimit: 3,
  subagents: true,
  browserHeadless: true,
  inputGuard: 'observe' as const,
  planFirst: 'off' as const,
}

/** Project Runtime-owned persisted defaults into the Desktop settings form. */
export function advancedSettingsFromRuntime(settings: RuntimeSettings): AdvancedAgentSettings {
  return {
    maxModelCalls: settings.max_model_calls,
    maxToolRetries: settings.max_tool_retries,
    researchSearchLimit: settings.research_search_limit,
    subagents: settings.subagents,
    browserHeadless: settings.browser_headless,
    inputGuard: settings.input_guard,
    planFirst: settings.plan_first,
  }
}

/** Convert the form to an explicit Runtime update; clearing a field restores its Runtime default. */
export function advancedSettingsToRuntime(
  settings: AdvancedAgentSettings,
): UpdateRuntimeSettingsRequest {
  return {
    max_model_calls: settings.maxModelCalls ?? runtimeDefaults.maxModelCalls,
    max_tool_retries: settings.maxToolRetries ?? runtimeDefaults.maxToolRetries,
    research_search_limit: settings.researchSearchLimit ?? runtimeDefaults.researchSearchLimit,
    subagents: settings.subagents ?? runtimeDefaults.subagents,
    browser_headless: settings.browserHeadless ?? runtimeDefaults.browserHeadless,
    input_guard: settings.inputGuard ?? runtimeDefaults.inputGuard,
    plan_first: settings.planFirst ?? runtimeDefaults.planFirst,
  }
}
