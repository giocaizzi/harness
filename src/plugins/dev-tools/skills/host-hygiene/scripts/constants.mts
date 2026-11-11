export const TYPES: readonly string[] = [
  "user",
  "feedback",
  "project",
  "reference",
];
export const APPEND =
  /\b(update[ds]?:|superseded|no longer|previously|was changed)/i;
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25000;
export const FILE_MAX_BYTES = 4000;

/** Branches the repo sweep never touches (globs; SWEEP_KEEP adds more). */
export const BOT_BRANCH_GLOBS: readonly string[] = [
  "dependabot/*",
  "renovate/*",
  "release-please--*",
];
export const DAY = 86400;
/** `--auto` runs at most once per this many seconds. */
export const AUTO_INTERVAL = DAY;
/** An `--auto` lock older than this many seconds is stale. */
export const LOCK_STALE = 3600;
/** Gives up on a walk over a huge tree after this many entries. */
export const WALK_CAP = 200000;
