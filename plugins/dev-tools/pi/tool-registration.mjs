function registrationState() {
    return (globalThis.__giocaizziHarnessPiToolRegistrationState ??= {
        hosts: new WeakSet(),
        keys: new Set(),
    });
}
/** Register this package's tool once across package copies in one Pi runtime. */
export function registerToolOnce(pi, toolKey, tool) {
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
