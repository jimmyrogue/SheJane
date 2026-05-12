# Jiandanly TODO

Last updated: 2026-05-12

This file tracks known follow-up issues that are intentionally deferred. Keep each item small, evidence-based, and actionable.

## Local Agent Harness

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
