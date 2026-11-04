// `node hooks/guard.mjs --contract`: the run contract this guard speaks, so a launcher can refuse to start on an
// older one.

import { CAPABILITIES, CONTRACT } from "../core/registration.mjs";
import type { Capability } from "../core/registration.mjs";

export interface ContractProbe {
  capabilities: Capability[];
  contract: typeof CONTRACT;
  guard: string;
}

// guard's version from its own .claude-plugin/plugin.json, "unknown" when it cannot be read.
export function guardVersion(pluginRoot?: string): string {
  throw new Error("not implemented");
}

export function contractProbe(version: string = guardVersion()): ContractProbe {
  return {
    contract: CONTRACT,
    capabilities: [...CAPABILITIES],
    guard: version,
  };
}
