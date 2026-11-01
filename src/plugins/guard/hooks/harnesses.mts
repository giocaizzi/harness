// Modular abstraction towards harnesses and their configuration.
// Centralizes harness-specific tool identifiers, execution environments, and capabilities.

import type { HarnessConfig, HarnessName } from "./types.mjs";

export const HARNESS_CONFIGS: Record<HarnessName, HarnessConfig> = {
  claude: {
    name: "claude",
    displayName: "Claude Code",
    kind: "command",
    envTrigger: "CLAUDE_PLUGIN_DATA",
    shellTools: ["bash", "powershell"],
    readTools: ["read"],
    editTools: ["edit", "write", "multiedit", "create"],
    taskTools: [],
    supportsNativeAsk: true,
  },
  copilot: {
    name: "copilot",
    displayName: "GitHub Copilot CLI",
    kind: "command",
    envTrigger: "COPILOT_PLUGIN_DATA",
    shellTools: ["bash", "powershell"],
    readTools: ["view"],
    editTools: ["edit", "write", "create_file", "apply_patch"],
    taskTools: [],
    supportsNativeAsk: true,
  },
  codex: {
    name: "codex",
    displayName: "Codex CLI",
    kind: "command",
    shellTools: ["bash", "powershell"],
    readTools: ["read", "view"],
    editTools: ["edit", "write", "apply_patch"],
    taskTools: [],
    supportsNativeAsk: false,
  },
  opencode: {
    name: "opencode",
    displayName: "opencode",
    kind: "in-process",
    shellTools: ["bash"],
    readTools: ["read"],
    editTools: ["edit", "write", "create"],
    taskTools: [],
    supportsNativeAsk: false,
    requiresAutoApprovalDeny: true,
  },
  pi: {
    name: "pi",
    displayName: "pi",
    kind: "in-process",
    shellTools: ["bash"],
    readTools: ["read"],
    editTools: ["edit", "write"],
    taskTools: [],
    supportsNativeAsk: true,
  },
  antigravity: {
    name: "antigravity",
    displayName: "Antigravity",
    kind: "command",
    shellTools: ["run_command"],
    readTools: ["read_file", "view_file"],
    editTools: ["edit_file", "write_file"],
    taskTools: [],
    supportsNativeAsk: true,
  },
  vscode: {
    name: "vscode",
    displayName: "VS Code Copilot",
    kind: "command",
    envTrigger: "CLAUDE_PLUGIN_ROOT",
    shellTools: ["run_in_terminal"],
    readTools: ["read_file"],
    editTools: [
      "edit_file",
      "replace_string_in_file",
      "multi_replace_string_in_file",
      "insert_edit_into_file",
    ],
    taskTools: ["run_task", "create_and_run_task"],
    supportsNativeAsk: true,
  },
  other: {
    name: "other",
    displayName: "Generic Harness",
    kind: "command",
    shellTools: ["bash", "powershell", "run_in_terminal", "run_command"],
    readTools: ["read", "view", "read_file", "view_file"],
    editTools: [
      "edit",
      "write",
      "multiedit",
      "create",
      "create_file",
      "replace_string_in_file",
      "multi_replace_string_in_file",
      "insert_edit_into_file",
      "edit_file",
      "write_file",
      "apply_patch",
    ],
    taskTools: ["run_task", "create_and_run_task"],
    supportsNativeAsk: false,
  },
};

export const ALL_SHELL_TOOLS: ReadonlySet<string> = new Set(
  Object.values(HARNESS_CONFIGS).flatMap((c) => c.shellTools),
);

export const ALL_READ_TOOLS: ReadonlySet<string> = new Set(
  Object.values(HARNESS_CONFIGS).flatMap((c) => c.readTools),
);

export const ALL_EDIT_TOOLS: ReadonlySet<string> = new Set(
  Object.values(HARNESS_CONFIGS).flatMap((c) => c.editTools),
);

export const ALL_TASK_TOOLS: ReadonlySet<string> = new Set(
  Object.values(HARNESS_CONFIGS).flatMap((c) => c.taskTools),
);

export function resolveHarness(name?: string | null): HarnessConfig {
  if (!name) return HARNESS_CONFIGS.other;
  const lower = name.toLowerCase();
  if (lower in HARNESS_CONFIGS) {
    return HARNESS_CONFIGS[lower as HarnessName];
  }
  return HARNESS_CONFIGS.other;
}

export function detectHarnessName(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): HarnessName {
  const flag = argv.find((a) => a.startsWith("--harness="));
  if (flag) {
    const raw = flag.slice("--harness=".length).toLowerCase();
    if (raw in HARNESS_CONFIGS) {
      return raw as HarnessName;
    }
    return "other";
  }
  if (env.CLAUDE_PLUGIN_DATA) return "claude";
  if (env.COPILOT_PLUGIN_DATA) return "copilot";
  if (env.CLAUDE_PLUGIN_ROOT) return "vscode";
  return "other";
}

export function detectHarness(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): HarnessConfig {
  return HARNESS_CONFIGS[detectHarnessName(argv, env)];
}

export function isShellTool(toolName: string, harness?: HarnessName): boolean {
  const norm = toolName.toLowerCase();
  if (harness) {
    const cfg = HARNESS_CONFIGS[harness];
    return cfg.shellTools.includes(norm);
  }
  return ALL_SHELL_TOOLS.has(norm);
}

export function isReadTool(toolName: string, harness?: HarnessName): boolean {
  const norm = toolName.toLowerCase();
  if (harness) {
    const cfg = HARNESS_CONFIGS[harness];
    return cfg.readTools.includes(norm);
  }
  return ALL_READ_TOOLS.has(norm);
}

export function isEditTool(toolName: string, harness?: HarnessName): boolean {
  const norm = toolName.toLowerCase();
  if (harness) {
    const cfg = HARNESS_CONFIGS[harness];
    return cfg.editTools.includes(norm);
  }
  return ALL_EDIT_TOOLS.has(norm);
}

export function isTaskTool(toolName: string, harness?: HarnessName): boolean {
  const norm = toolName.toLowerCase();
  if (harness) {
    const cfg = HARNESS_CONFIGS[harness];
    return cfg.taskTools.includes(norm);
  }
  return ALL_TASK_TOOLS.has(norm);
}
