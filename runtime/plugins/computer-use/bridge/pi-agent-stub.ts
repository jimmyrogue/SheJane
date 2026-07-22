import os from "node:os";
import path from "node:path";

export function getAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}
