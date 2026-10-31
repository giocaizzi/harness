// Which alerts and sounds a turn raises. This module deliberately has no harness imports.
export type AlertLevel = 0 | 80 | 90 | 100;
export type LimitKind = "five_hour" | "seven_day" | "spend_limit";
export type SoundKey =
  | "soundContext"
  | "soundLimit5h"
  | "soundLimit7d"
  | "soundLimitSpend"
  | "soundDone"
  | "soundAborted"
  | "soundRefused"
  | "soundError"
  | "soundSubagent"
  | "soundNeedsInput";

type LimitKey = "soundLimit5h" | "soundLimit7d" | "soundLimitSpend";
type LevelKey = "ctx" | LimitKind;
type Levels = Partial<Record<LevelKey, AlertLevel>>;
type Limits = Partial<Record<LimitKind, number>>;
type TurnReason = "aborted" | "refusal" | "error" | "answer" | "done";

export interface Turn {
  agentId?: string;
  durationMs: number;
  reason: TurnReason;
}

export interface Alert {
  key: SoundKey;
  text: string;
}

export interface SettleInput {
  aborted?: boolean;
  agentId?: string;
  before: Levels;
  durationMs: number;
  error?: boolean;
  pct: number | null | undefined;
}

export const TTL_MS: Record<"5m" | "1h", number> = {
  "5m": 300_000,
  "1h": 3_600_000,
};

export const clock = (milliseconds: number): string =>
  `${String(Math.floor(milliseconds / 60_000))}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}`;

const LIMITS: readonly { key: LimitKey; kind: LimitKind; label: string }[] = [
  { key: "soundLimit5h", kind: "five_hour", label: "5h window" },
  { key: "soundLimit7d", kind: "seven_day", label: "7d window" },
  { key: "soundLimitSpend", kind: "spend_limit", label: "Spend limit" },
];

const levelOf = (percent: number): AlertLevel =>
  percent >= 100 ? 100 : percent >= 90 ? 90 : percent >= 80 ? 80 : 0;

/** Return newly crossed context and rate-limit alert levels. */
export function alerts(
  context: number | null | undefined,
  limits: Limits,
  before: Levels = {},
): { alerts: Alert[]; now: Levels } {
  const contextLevel = levelOf(context ?? 0);
  const now: Levels = { ctx: contextLevel >= 90 ? 90 : contextLevel };
  const raised: Alert[] = [];
  if (now.ctx !== undefined && now.ctx > (before.ctx ?? 0)) {
    const percentage = String(context ?? 0);
    raised.push({
      key: "soundContext",
      text:
        now.ctx === 90
          ? `Context ${percentage}%: compact now`
          : `Context ${percentage}%: compact soon`,
    });
  }
  for (const { key, kind, label } of LIMITS) {
    const percent = limits[kind];
    const level = percent === undefined ? 0 : levelOf(percent);
    now[kind] = level;
    if (level > (before[kind] ?? 0)) {
      raised.push({
        key,
        text:
          level === 100
            ? `${label} reached`
            : `${label} ${String(Math.round(percent ?? 0))}% used`,
      });
    }
  }
  return { alerts: raised, now };
}

/** Select the setting for a completed turn, if it should make a sound. */
export function turnSound(turn: Turn, doneAfterSeconds = 0): SoundKey | null {
  if (turn.agentId) return "soundSubagent";
  if (turn.reason === "aborted") return "soundAborted";
  if (turn.reason === "refusal") return "soundRefused";
  if (turn.reason === "error") return "soundError";
  return turn.durationMs >= doneAfterSeconds * 1000 ? "soundDone" : null;
}

const took = (milliseconds: number): string =>
  milliseconds < 60_000
    ? `${String(Math.round(milliseconds / 1000))}s`
    : `${String(Math.floor(milliseconds / 60_000))}m ${String(Math.round((milliseconds % 60_000) / 1000))}s`;

/** Return a user-facing completion notice when the completed turn warrants one. */
export function turnNotice(turn: Turn, afterSeconds = 60): string | null {
  if (turn.agentId || turn.reason === "aborted") return null;
  if (turn.reason === "refusal") return "The model refused the turn";
  if (turn.reason === "error") return "The turn ended on an API error";
  return turn.durationMs >= afterSeconds * 1000
    ? `Turn finished in ${took(turn.durationMs)}`
    : null;
}

interface PullRequestState {
  ci?: "pending" | "fail" | "pass";
  number: number;
}

interface RepositoryState {
  pr?: PullRequestState;
}

/** Describe a completed check transition on the current pull request. */
export function ciNotice(
  previous: RepositoryState | null | undefined,
  value: RepositoryState | null | undefined,
): string | null {
  const before = previous?.pr;
  const after = value?.pr;
  if (!before || !after) return null;
  if (
    before.number !== after.number ||
    before.ci !== "pending" ||
    !after.ci ||
    after.ci === "pending"
  )
    return null;
  return after.ci === "fail"
    ? `Checks failed on #${String(after.number)}`
    : `Checks passed on #${String(after.number)}`;
}

export const CLIPS: Readonly<Record<SoundKey, string | null>> = {
  soundContext: "alert",
  soundDone: "done",
  soundAborted: null,
  soundRefused: "error",
  soundError: "error",
  soundSubagent: "tick",
  soundNeedsInput: "chime",
  soundLimit5h: "alert",
  soundLimit7d: "alert",
  soundLimitSpend: "alert",
};

const isClip = (clip: string | null): clip is string => clip !== null;

/** Collect clips, notices, and the next alert state for a completed harness run. */
export function settle({
  durationMs,
  aborted,
  error,
  agentId,
  pct,
  before,
}: SettleInput): { clips: string[]; notices: string[]; now: Levels } {
  const turn: Turn = {
    durationMs,
    agentId,
    reason: aborted ? "aborted" : error ? "error" : "done",
  };
  const { alerts: raised, now } = alerts(pct, {}, before);
  const clips = [turnSound(turn), ...raised.map((alert) => alert.key)]
    .map((key) => (key === null ? null : CLIPS[key]))
    .filter(isClip);
  const notices = [
    turnNotice(turn),
    ...raised.map((alert) => alert.text),
  ].filter((notice): notice is string => notice !== null);
  return { clips: [...new Set(clips)], notices, now };
}
