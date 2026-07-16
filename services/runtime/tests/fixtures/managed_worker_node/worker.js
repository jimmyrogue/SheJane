"use strict";

const fs = require("node:fs");
const readline = require("node:readline");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = input[Symbol.asyncIterator]();

async function request(method, id) {
  const { value, done } = await lines.next();
  if (done) throw new Error(`missing ${method} request`);
  const message = JSON.parse(value);
  if (message.jsonrpc !== "2.0" || message.id !== id || message.method !== method) {
    throw new Error(`unexpected ${method} request`);
  }
  return message.params;
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

async function main() {
  const initialize = await request("initialize", 1);
  if (initialize.protocol_version !== 1 || initialize.plugin_id !== "org.shejane.node-gate") {
    throw new Error("incompatible runtime");
  }
  reply(1, {
    protocol_version: 1,
    process_isolated: true,
    access_isolated: process.env.SHEJANE_PLUGIN_ACCESS_ISOLATED === "1",
    resource_isolated: process.env.SHEJANE_PLUGIN_RESOURCE_ISOLATED === "1",
    sandboxed: process.env.SHEJANE_PLUGIN_SANDBOXED === "1",
  });

  const invocation = await request("invoke", 2);
  const assets = JSON.parse(process.env.SHEJANE_PLUGIN_RUNTIME_ASSETS || "{}");
  const runtime = assets["org.nodejs.runtime"];
  if (runtime !== "/package/.shejane-host/runtime-assets/org.nodejs.runtime") {
    throw new Error("Node.js runtime asset is unavailable");
  }
  let runtimeReadOnly = false;
  try {
    fs.appendFileSync(`${runtime}/bin/node`, "denied");
  } catch (error) {
    runtimeReadOnly = error && ["EACCES", "EROFS"].includes(error.code);
  }
  if (process.getuid() !== 65534 || !runtimeReadOnly) {
    throw new Error("Node.js worker isolation changed");
  }
  reply(2, {
    schema_version: 1,
    invocation_id: invocation.invocation_id,
    operation_id: invocation.operation_id,
    status: "succeeded",
    output: {
      node_version: process.version,
      runtime_asset_read_only: runtimeReadOnly,
      uid: process.getuid(),
    },
    artifacts: [],
  });
  await request("shutdown", 3);
  reply(3, {});
  input.close();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
