// Type definitions for the guard hook layer, harness abstractions, and hook lifecycles.
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
