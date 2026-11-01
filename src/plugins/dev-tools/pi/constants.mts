import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGINS: string = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Claude tool names in an agent's `tools` -> pi's built-in tools. No `tools` key: pi's defaults.
// pi's thinking levels: a Claude `effort` (low … max) is one of them as is.
export const THINKING: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ["read"],
  grep: ["grep"],
  glob: ["find", "ls"],
  bash: ["bash"],
  powershell: ["powershell"],
  edit: ["edit"],
  multiedit: ["edit"],
  write: ["write"],
};

export const MAX_DEPTH = 3;
