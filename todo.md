# SheJane TODO

Last updated: 2026-05-13

This file tracks known follow-up issues that are intentionally deferred. Keep each item small, evidence-based, and actionable.

## Recently Closed

### Phase 2.22 - Tavily / platform key leakage risk

- **Status:** Closed in Phase 2.22.
- **Change:** Tavily-backed `web.search` now runs through Cloud Tool Gateway, is metered with wallet credits, writes `external_tool_call_records`, and is visible in admin as read-only tool calls.
- **Boundary:** Local Host no longer reads Tavily provider env vars; `make dev-electron` starts Local Host / client / Electron with an allowlist environment so cloud-only provider, Stripe, and AWS secrets are not inherited.

## Local Agent Harness

### P1 - Do not exhaust research navigation budget on weak candidates before target sources

- **Issue:** The research navigation budget can be consumed by blocked/weak candidates such as Reuters 401 pages, TechCrunch category pages, repeated reads, and duplicate fetches before the run collects the requested number of strong sources.
- **Evidence:** Run `2602e44b-65ae-431a-9bf0-4b9e44f10e61` collected only one strong source (`https://www.cnbc.com/2026/05/12/qualcomm-chip-stocks-record-ai.html`). The later BBC article open/fetch was blocked by `research_navigation_budget_exhausted` after weak candidates had already consumed the source navigation budget.
- **Expected:** Failed, blocked, portal/listing, duplicate, or already-opened attempts should have a smaller budget cost than new credible article/detail candidates. The harness should preserve enough budget to collect the requested number of strong sources.
- **Likely fix:** Track navigation budget by `source_attempt_kind` and count only unique credible candidate article/detail navigations against the strict source budget; keep a separate lower-severity diagnostic counter for weak/failed attempts.

### P1 - Treat insufficient-source research finals as partial, not successful completion

- **Issue:** A research run can complete with fewer collected sources than requested if the final answer acknowledges limitations, even when the user explicitly requested a source count and source links.
- **Evidence:** Run `2602e44b-65ae-431a-9bf0-4b9e44f10e61` completed with one collected source and one final citation, while the prompt requested two credible sources. The answer summarized a BBC item from search-result snippets and stated the original could not be fetched.
- **Expected:** For tasks that explicitly require `N` credible sources, `run.completed` should only happen with at least `N` collected source URLs, or the run should complete with an explicit `partial`/`limited` reason and UI warning that the requested evidence threshold was not met.
- **Likely fix:** Add a `run.completed_partial` / `reason=insufficient_sources_partial` path, or keep finalization retrying toward additional sources until hard research budgets are reached; make the analyzer and UI distinguish accepted partial answers from successful evidence-grounded answers.

### P1 - Tighten browser research source evidence

- **Issue:** `source.collected` can currently treat a portal/home page as a completed research source.
- **Evidence:** Run `b6499fd8-095c-4a26-a833-07afd2800a27` collected `https://www.stdaily.com/` as one of the two required sources, then blocked opening a second article with `research_enough_sources`.
- **Expected:** Only article/detail pages, or pages with strong page-level evidence, should count toward the target source count. Home pages, topic pages, and search/list pages should be context only.
- **Likely fix:** Add `source_kind` or `evidence_level` to browser observations and count only strong evidence sources in research policy.

### P1 - Re-run final answer guardrail after correction

- **Issue:** `run.output_guardrail` fires once, but a later final answer can still cite a URL that was not fully collected.
- **Evidence:** Run `b6499fd8-095c-4a26-a833-07afd2800a27` first triggered `uncollected_source_cited`, then completed with a caveated citation to an uncollected article URL.
- **Expected:** Final answers should be checked every time before `run.completed`, or the guardrail should allow a limited retry budget instead of a one-shot check.
- **Likely fix:** Track guardrail attempts by reason and allow repeated validation until the final answer cites only collected sources or clearly states the limitation without presenting the URL as verified.

### P1 - Bind `browser.verify` to the verified page URL

- **Issue:** `browser.verify` validates the current managed page, but the final answer may imply that another URL was verified.
- **Evidence:** Run `b6499fd8-095c-4a26-a833-07afd2800a27` verified text on `content_514911.html`, while the final answer referenced `content_515253.html` as a source.
- **Expected:** Verification should explicitly bind `expectUrl` / current URL / cited URL. A page should not verify a different page merely because a sidebar link mentions it.
- **Likely fix:** Add optional `expectUrl` to `browser.verify`, include canonical verified URL in the result, and make the output guardrail compare claims against verified URLs.

### P2 - Reduce unnecessary research steps after enough evidence

- **Issue:** Some research runs still continue with blocked opens, fetches, scrolls, and snapshots after enough evidence or after a guardrail correction.
- **Evidence:** Run `b6499fd8-095c-4a26-a833-07afd2800a27` completed successfully, but used 18 LLM rounds and several redundant blocked operations.
- **Expected:** Once the research policy reports enough strong sources, the model should stop browsing and answer. If blocked repeatedly, the harness should inject a stronger stop instruction.
- **Likely fix:** Add a local stop-intent observation after repeated `research_enough_sources`, and strengthen prompt guidance around "answer now" behavior.

### P2 - Clean up diagnostics payload display values

- **Issue:** Some timeline/debug payloads can stringify missing fields as `"undefined"`.
- **Evidence:** Previous local-host logs showed fields such as `path:"undefined"` and `characters:"undefined"` in `ui.action.completed`.
- **Expected:** Missing optional fields should be omitted or encoded as `null`, not the string `"undefined"`.
- **Likely fix:** Normalize event payload serialization in semantic event appenders and client timeline rendering.
