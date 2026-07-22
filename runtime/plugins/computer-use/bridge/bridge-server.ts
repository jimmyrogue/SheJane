import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  executeAct,
  executeExpandUi,
  executeFind,
  executeInspectUi,
  executeObserve,
  executeReadText,
  executeSearchUi,
  executeWaitFor,
  shutdownComputerUseSession,
} from "__UPSTREAM_BRIDGE__";
import { HELPER_APP_PATH, macosHelper } from "__UPSTREAM_HELPER__";

const packageRoot = process.env.SHEJANE_COMPUTER_USE_PACKAGE_ROOT;
const workspace = process.env.SHEJANE_COMPUTER_USE_WORKSPACE || process.cwd();
if (!packageRoot) throw new Error("SHEJANE_COMPUTER_USE_PACKAGE_ROOT is required");

const ctx = {
  cwd: workspace,
  hasUI: false,
  ui: {
    notify() {},
    async select() { return undefined; },
  },
  sessionManager: { getBranch: () => [] },
};

const executors: Record<string, Function> = {
  find_roots: executeFind,
  observe_ui: executeObserve,
  search_ui: executeSearchUi,
  expand_ui: executeExpandUi,
  inspect_ui: executeInspectUi,
  act_ui: executeAct,
  read_text: executeReadText,
  wait_for: executeWaitFor,
};

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", BUN_BE_BUN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8192); });
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8192); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(output.trim() || `setup exited with ${code}`)));
  });
}

async function setup() {
  const script = path.join(packageRoot!, "payload", "upstream", "scripts", "setup-helper.mjs");
  if (!existsSync(script)) throw new Error("The pinned helper installer is missing from this plugin package.");
  await run(process.execPath, [script, "--runtime"]);
  await macosHelper.restart();
  await macosHelper.command("registerPermissions", {}, { timeoutMs: 15_000 });
  await macosHelper.command("openPermissionPane", { kind: "accessibility" });
  await macosHelper.command("openPermissionPane", { kind: "screenRecording" });
  return {
    text: `Installed pi-computer-use.app at ${HELPER_APP_PATH}. Enable Accessibility and Screen Recording, then run status.`,
    details: { helperPath: HELPER_APP_PATH },
  };
}

async function status() {
  if (!existsSync(HELPER_APP_PATH)) {
    return { text: "Computer Use helper is not installed. Run setup.", details: { installed: false, helperPath: HELPER_APP_PATH } };
  }
  const ready = await macosHelper.ensureDaemon();
  if (!ready) return { text: "Computer Use helper is installed but unavailable.", details: { installed: true, ready: false, helperPath: HELPER_APP_PATH } };
  const [diagnostics, permissions] = await Promise.all([
    macosHelper.command("diagnostics", {}),
    macosHelper.command("checkPermissions", {}),
  ]);
  const accessibility = permissions?.accessibility === true;
  const screenRecording = permissions?.screenRecordingCapturable === true;
  return {
    text: `Accessibility: ${accessibility ? "granted" : "missing"}; Screen Recording: ${screenRecording ? "granted" : "missing"}.`,
    details: { installed: true, ready: true, accessibility, screenRecording, helperPath: HELPER_APP_PATH, diagnostics },
  };
}

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "imageBase64")
    .map(([key, item]) => [key, clean(item)]));
}

async function invoke(action: string, args: Record<string, unknown>) {
  if (action === "setup") return await setup();
  if (action === "status") return await status();
  const executor = executors[action];
  if (!executor) throw new Error(`Unknown Computer Use action: ${action}`);
  const result = await executor(`shejane-${Date.now()}`, args, undefined, undefined, ctx);
  const text = result.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
  const images = result.content
    .filter((item: any) => item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
    .map((item: any) => ({ base64: item.data, mime_type: item.mimeType }));
  return { text, details: clean(result.details), ...(images.length ? { images } : {}) };
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let id: unknown;
  try {
    const request = JSON.parse(line);
    id = request.id;
    const result = await invoke(String(request.action), request.arguments || {});
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, error: { message: error instanceof Error ? error.message : String(error) } })}\n`);
  }
}
await shutdownComputerUseSession();
