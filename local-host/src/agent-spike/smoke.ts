/**
 * Phase 0 smoke driver — verifies the 4 hard criteria from the migration plan.
 *
 *   1. First-token latency end-to-end < 1000 ms
 *   2. `time.now` reverse-call RPC p50 < 5 ms
 *   3. Killing Python mid-run -> Node observes exit & reports failure < 2 s
 *   4. interrupt() + Command(resume=) round-trip without corruption
 *
 * Run:  pnpm --filter jiandanly-local-host tsx src/agent-spike/smoke.ts
 *  or:  npx tsx local-host/src/agent-spike/smoke.ts
 */

import {
  defaultPythonProjectDir,
  getToolTimings,
  startSidecar,
  type SidecarHandle,
} from "./sidecar.js";

interface RunNotifications {
  firstTokenAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  waitingAt: number | null;
  tokens: number;
  errorMessage?: string;
  finalText?: string;
}

function attachRunListeners(handle: SidecarHandle): RunNotifications {
  const n: RunNotifications = {
    firstTokenAt: null,
    completedAt: null,
    failedAt: null,
    waitingAt: null,
    tokens: 0,
  };
  handle.rpc.onNotification((method, params) => {
    const now = performance.now();
    switch (method) {
      case "llm.token":
        n.tokens += 1;
        if (n.firstTokenAt === null) n.firstTokenAt = now;
        break;
      case "run.completed":
        n.completedAt = now;
        n.finalText = params?.finalText;
        break;
      case "run.failed":
        n.failedAt = now;
        n.errorMessage = params?.errorMessage;
        break;
      case "run.waiting":
        n.waitingAt = now;
        break;
      default:
        break;
    }
  });
  return n;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout: ${what} not satisfied within ${timeoutMs}ms`);
}

function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function header(label: string): void {
  console.log("\n========================================");
  console.log(label);
  console.log("========================================");
}

function checkmark(ok: boolean): string {
  return ok ? "✅" : "❌";
}

async function scenario1FirstTokenLatency(): Promise<{ pass: boolean; latencyMs: number }> {
  header("Hard #1: first-token latency end-to-end (< 1000ms)");
  const handle = await startSidecar({ pythonProjectDir: defaultPythonProjectDir() });
  const notes = attachRunListeners(handle);
  try {
    const startCallAt = performance.now();
    await handle.rpc.call("run.start", { runId: "run_lat_1", goal: "what time is it", scenario: "time" });
    await waitUntil(() => notes.firstTokenAt !== null, 5000, "first token");
    await waitUntil(() => notes.completedAt !== null || notes.failedAt !== null, 5000, "run terminal");
    const latency = (notes.firstTokenAt ?? performance.now()) - startCallAt;
    const pass = latency < 1000 && notes.completedAt !== null;
    console.log(
      `  first-token: ${latency.toFixed(1)} ms  (tokens: ${notes.tokens}, final: ${JSON.stringify(notes.finalText)})  ${checkmark(pass)}`
    );
    return { pass, latencyMs: latency };
  } finally {
    await handle.shutdown();
  }
}

async function scenario2ToolRpcLatency(): Promise<{ pass: boolean; p50: number; count: number }> {
  header("Hard #2: tool.invoke (time.now) p50 < 5ms");
  const handle = await startSidecar({ pythonProjectDir: defaultPythonProjectDir() });
  const N = 20;
  const baseline = getToolTimings().length;
  try {
    for (let i = 0; i < N; i += 1) {
      const notes = attachRunListeners(handle);
      await handle.rpc.call("run.start", {
        runId: `run_tool_${i}`,
        goal: "time",
        scenario: "time",
      });
      await waitUntil(
        () => notes.completedAt !== null || notes.failedAt !== null,
        5000,
        `run ${i} terminal`
      );
      if (notes.failedAt !== null) {
        throw new Error(`run ${i} failed: ${notes.errorMessage ?? "(no message)"}`);
      }
    }
    const recent = getToolTimings().slice(baseline, baseline + N);
    const p50 = percentile(recent, 50);
    const p95 = percentile(recent, 95);
    const pass = p50 < 5;
    console.log(`  samples=${recent.length}  p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  ${checkmark(pass)}`);
    return { pass, p50, count: recent.length };
  } finally {
    await handle.shutdown();
  }
}

async function scenario3CrashRecovery(): Promise<{ pass: boolean; elapsedMs: number }> {
  header("Hard #3: kill Python mid-run -> Node observes within 2s");
  const handle = await startSidecar({ pythonProjectDir: defaultPythonProjectDir() });
  try {
    let closedAt: number | null = null;
    handle.rpc.whenClosed(() => {
      if (closedAt === null) closedAt = performance.now();
    });
    let exitedAt: number | null = null;
    void handle.exit.then(() => {
      if (exitedAt === null) exitedAt = performance.now();
    });
    await handle.rpc.call("run.start", { runId: "run_crash_1", goal: "time", scenario: "time" });
    const killedAt = performance.now();
    process.kill(handle.pid, "SIGKILL");
    await waitUntil(() => closedAt !== null || exitedAt !== null, 5000, "peer close or exit");
    const observedAt = closedAt ?? exitedAt ?? performance.now();
    const elapsed = observedAt - killedAt;
    const pass = elapsed < 2000;
    console.log(
      `  Node observed peer ${closedAt !== null ? "close" : "exit"} ${elapsed.toFixed(1)} ms after SIGKILL  ${checkmark(pass)}`
    );
    return { pass, elapsedMs: elapsed };
  } finally {
    try {
      await handle.shutdown();
    } catch {}
  }
}

async function scenario4InterruptResume(): Promise<{ pass: boolean }> {
  header("Hard #4: interrupt() on destructive tool -> Command(resume=) completes the run");
  const handle = await startSidecar({ pythonProjectDir: defaultPythonProjectDir() });
  const notes = attachRunListeners(handle);
  try {
    await handle.rpc.call("run.start", { runId: "run_int_1", goal: "write a file", scenario: "write" });
    await waitUntil(() => notes.waitingAt !== null, 5000, "run.waiting");
    console.log(`  graph paused (waiting). resuming with approved=true...`);
    await handle.rpc.call("run.resume", { runId: "run_int_1", payload: { approved: true, scope: "once" } });
    await waitUntil(() => notes.completedAt !== null || notes.failedAt !== null, 5000, "run terminal");
    const pass = notes.completedAt !== null && notes.failedAt === null;
    console.log(
      `  final state: completed=${notes.completedAt !== null}  failed=${notes.failedAt !== null} (${notes.errorMessage ?? "-"})  ${checkmark(pass)}`
    );
    return { pass };
  } finally {
    await handle.shutdown();
  }
}

async function main(): Promise<void> {
  console.log("Phase 0 spike — running 4 hard-criteria scenarios sequentially.\n");
  const results: { name: string; pass: boolean }[] = [];

  try {
    const r1 = await scenario1FirstTokenLatency();
    results.push({ name: "first-token latency < 1s", pass: r1.pass });
  } catch (e) {
    console.error("scenario 1 errored:", e);
    results.push({ name: "first-token latency < 1s", pass: false });
  }

  try {
    const r2 = await scenario2ToolRpcLatency();
    results.push({ name: "tool RPC p50 < 5ms", pass: r2.pass });
  } catch (e) {
    console.error("scenario 2 errored:", e);
    results.push({ name: "tool RPC p50 < 5ms", pass: false });
  }

  try {
    const r3 = await scenario3CrashRecovery();
    results.push({ name: "crash recovery < 2s", pass: r3.pass });
  } catch (e) {
    console.error("scenario 3 errored:", e);
    results.push({ name: "crash recovery < 2s", pass: false });
  }

  try {
    const r4 = await scenario4InterruptResume();
    results.push({ name: "interrupt/resume round-trip", pass: r4.pass });
  } catch (e) {
    console.error("scenario 4 errored:", e);
    results.push({ name: "interrupt/resume round-trip", pass: false });
  }

  header("Summary");
  for (const r of results) {
    console.log(`  ${checkmark(r.pass)}  ${r.name}`);
  }
  const allPass = results.every((r) => r.pass);
  console.log(`\n${allPass ? "✅ ALL HARD CRITERIA PASS" : "❌ SOME CRITERIA FAILED"} — Phase 0 ${allPass ? "GO" : "NO-GO"}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(2);
});
