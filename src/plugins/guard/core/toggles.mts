// Rule toggles: GUARD_RULES switches guard's rules on and off, from the hook's environment only. Pure: the adapters pass
// the environment in, the engine takes the resulting set and skips a disabled rule where it is evaluated.

import type { Capability } from "./registration.mjs";

export const RULE_IDS = [
  "risky",
  "title",
  "python",
  "skills",
  "hints",
  "host",
  "push-scan",
  "pr-batch",
  "stack-hint",
  "stale-plugins",
  "lifecycle",
  "stop-check",
  "lint",
  "awake",
  "run-labels",
  "protected-paths",
  "result-gate",
] as const;
export type RuleId = (typeof RULE_IDS)[number];
export type RuleSet = Record<RuleId, boolean>;

type Env = Readonly<Record<string, string | undefined>>;

const allOn = (): RuleSet =>
  Object.fromEntries(RULE_IDS.map((id) => [id, true])) as RuleSet;

const isRuleId = (s: string): s is RuleId =>
  (RULE_IDS as readonly string[]).includes(s);

export interface ParsedRules {
  // The bad token (cut to 100 characters) when the value is invalid; `rules` is then all on.
  invalid?: string;
  rules: RuleSet;
}

// Comma- or space-separated tokens applied left to right over all-on defaults: `all` or `none` set every rule, `id` or
// `+id` turns one on, `-id` turns one off. Any other token makes the whole value invalid: the defaults apply.
export function parseRules(value: string | undefined): ParsedRules {
  const rules = allOn();
  for (const token of (value ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (token === "all" || token === "none") {
      for (const id of RULE_IDS) rules[id] = token === "all";
      continue;
    }
    const on = !token.startsWith("-");
    const id = token.replace(/^[+-]/, "");
    if (!isRuleId(id)) return { rules: allOn(), invalid: token.slice(0, 100) };
    rules[id] = on;
  }
  return { rules };
}

const OFF = /^(0|false|off)$/i;

// The older single switch of a rule: true when it turns the rule off, with each check's own spelling.
const LEGACY_OFF: Partial<Record<RuleId, (env: Env) => boolean>> = {
  host: (env) => env.GUARD_HOST_CHECK === "off",
  "push-scan": (env) => OFF.test(env.GUARD_PUSH_SCAN ?? ""),
  "stack-hint": (env) => OFF.test(env.GUARD_STACK_HINT ?? ""),
  lifecycle: (env) => OFF.test(env.GUARD_LIFECYCLE ?? ""),
  "stop-check": (env) => env.GUARD_STOP_CHECK === "off",
  "result-gate": (env) => env.GUARD_RESULT_GATE === "off",
};

// The rules a registered run's required capabilities keep on whatever GUARD_RULES says. The older switches still apply.
const FLOOR: Partial<Record<Capability, RuleId>> = {
  labels: "run-labels",
  "protected-paths": "protected-paths",
  "result-gate": "result-gate",
};

// Whether a rule runs: GUARD_RULES enables it (or a capability the run requires floors it) and its older switch is not off.
export function ruleOn(
  env: Env,
  id: RuleId,
  required: readonly Capability[] = [],
): boolean {
  const floored = required.some((c) => FLOOR[c] === id);
  return (
    (floored || parseRules(env.GUARD_RULES).rules[id]) && !LEGACY_OFF[id]?.(env)
  );
}

// Every rule's state in this environment.
export function effectiveRules(
  env: Env,
  required: readonly Capability[] = [],
): RuleSet {
  return Object.fromEntries(
    RULE_IDS.map((id) => [id, ruleOn(env, id, required)]),
  ) as RuleSet;
}
