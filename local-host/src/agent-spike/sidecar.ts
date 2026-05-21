/**
 * Phase 0 sidecar manager.
 *
 * Spawns the Python langgraph-spike subprocess, hands it a Unix domain
 * socket to connect back on, and exposes a typed RPC client for the
 * smoke driver. Also implements the Node-side tool reverse-call handlers.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RpcEndpoint } from "./rpc.js";

export interface SidecarOptions {
  /** Path to the python-spike directory (so we know where to launch uv). */
  pythonProjectDir: string;
  /** Args to pass after `--socket`. */
  extraArgs?: string[];
  /** How long to wait for sidecar.ready before treating it as dead. */
  readyTimeoutMs?: number;
}

export interface SidecarHandle {
  rpc: RpcEndpoint;
  pid: number;
  socketPath: string;
  /** Resolves when Python process exits, with the exit code (or null). */
  exit: Promise<number | null>;
  shutdown: () => Promise<void>;
}

const TOOL_TIMINGS: number[] = [];

export function getToolTimings(): readonly number[] {
  return TOOL_TIMINGS;
}

function registerToolHandlers(rpc: RpcEndpoint): void {
  rpc.register("tool.invoke", async (params: any) => {
    const started = performance.now();
    const { toolName, arguments: args } = params ?? {};
    let result: any;
    switch (toolName) {
      case "time.now": {
        result = {
          ok: true,
          output: {
            iso: new Date().toISOString(),
            epochMs: Date.now(),
            timezone: args?.timezone ?? "UTC",
          },
        };
        break;
      }
      case "fs.write": {
        // destructive sample tool; the test path approves it
        result = { ok: true, output: { wrote: args?.path, bytes: (args?.content ?? "").length } };
        break;
      }
      default:
        result = { ok: false, errorCode: "tool_not_found", errorMessage: `unknown tool ${toolName}` };
    }
    const elapsed = performance.now() - started;
    TOOL_TIMINGS.push(elapsed);
    return result;
  });

  let permCounter = 0;
  rpc.register("permission.create", async (params: any) => {
    permCounter += 1;
    return `perm_${permCounter}_${params?.toolName ?? "unknown"}`;
  });
}

export async function startSidecar(opts: SidecarOptions): Promise<SidecarHandle> {
  const tmpDir = mkdtempSync(join(tmpdir(), "jdl-spike-"));
  const socketPath = join(tmpDir, "rpc.sock");
  const checkpointPath = join(tmpDir, "checkpoint.sqlite");

  const server: Server = createServer();
  const connectionPromise = new Promise<Socket>((resolve, reject) => {
    server.once("connection", resolve);
    server.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => resolve());
    server.once("error", reject);
  });

  const projectDir = opts.pythonProjectDir;
  const child: ChildProcess = spawn(
    "uv",
    [
      "run",
      "--directory",
      projectDir,
      "python",
      "runner.py",
      "--socket",
      socketPath,
      "--checkpoint",
      checkpointPath,
      ...(opts.extraArgs ?? []),
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    }
  );

  const exitPromise = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  let socket: Socket;
  try {
    socket = await Promise.race([
      connectionPromise,
      new Promise<Socket>((_, reject) =>
        setTimeout(
          () => reject(new Error(`sidecar did not connect within ${opts.readyTimeoutMs ?? 8000}ms`)),
          opts.readyTimeoutMs ?? 8000
        )
      ),
    ]);
  } catch (err) {
    child.kill("SIGTERM");
    server.close();
    try {
      unlinkSync(socketPath);
    } catch {}
    throw err;
  }

  const rpc = new RpcEndpoint(socket);
  registerToolHandlers(rpc);

  // Cleanup once peer closes.
  rpc.whenClosed(() => {
    server.close();
    try {
      unlinkSync(socketPath);
    } catch {}
  });

  const cleanupTmp = (): void => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  const handle: SidecarHandle = {
    rpc,
    pid: child.pid ?? -1,
    socketPath,
    exit: exitPromise.then((code) => {
      cleanupTmp();
      return code;
    }),
    shutdown: async () => {
      if (!child.killed) child.kill("SIGTERM");
      await exitPromise;
      rpc.close();
      server.close();
      cleanupTmp();
    },
  };
  return handle;
}

/** Resolve the python-spike dir relative to this file's location at runtime. */
export function defaultPythonProjectDir(): string {
  // src/agent-spike/sidecar.ts  ->  ../../python-spike
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "..", "..", "python-spike");
}
