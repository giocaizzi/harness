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
