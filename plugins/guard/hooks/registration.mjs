// Run contract v2: loads the runner's registration from GUARD_RUN_MANIFEST, read on every hook call. The manifest
// (and its result.checker) must be out of this user's reach, as the result checker is (hooks/checker.mjs), and its
// realpath and sha256 are pinned in the session's state on first sight: a later change denies. Not wired into
// decisions yet: contract v1 stays the enforced contract until guard 1.0.0.
export function createRegistrationCache() {
    throw new Error("not implemented");
}
// The session's pin file: <dataDir>/sessions/<session id>.run.jsonl, next to its facts file.
export function pinFile(dataDir, sessionId) {
    throw new Error("not implemented");
}
// The registration for this hook call: none (no GUARD_RUN_* variable), registered, or a deny with rule
// run-registration. Never throws.
export function loadRegistration(env, opts = {}) {
    throw new Error("not implemented");
}
