import type { PiHost } from "./types.mjs";

interface ToolRegistrationState {
  hosts: WeakSet<PiHost>;
  keys: Set<string>;
}

declare global {
  var __giocaizziHarnessPiToolRegistrationState:
    ToolRegistrationState | undefined;
}

function registrationState(): ToolRegistrationState {
  return (globalThis.__giocaizziHarnessPiToolRegistrationState ??= {
    hosts: new WeakSet(),
    keys: new Set(),
  });
}

/** Register this package's tool once across package copies in one Pi runtime. */
export function registerToolOnce(
  pi: PiHost,
  toolKey: "ask_question" | "subagent",
  tool: Parameters<PiHost["registerTool"]>[0],
): boolean {
  const state = registrationState();
  if (!state.hosts.has(pi)) {
    pi.on("session_shutdown", () => {
      state.keys.clear();
    });
    state.hosts.add(pi);
  }

  const key = `giocaizzi-harness:pi:${toolKey}`;
  if (state.keys.has(key)) {
    return false;
  }
  pi.registerTool(tool);
  state.keys.add(key);
  return true;
}
