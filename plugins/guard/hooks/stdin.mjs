// Reads a hook's payload from stdin without ever truncating it silently: the caller learns whether the whole payload
// arrived, so a hook can fail closed on a partial read instead of judging half a tool call.
export const STDIN_MAX_BYTES = 32 * 1024 * 1024;
// Hook timeouts in hooks.json: 30 s for PreToolUse, 10 s for the other guard events; Codex's generated SessionEnd hook
// has 3 s. The reminder events fail open, so a read cut short by a harness timeout is harmless there. A PreToolUse
// hook still spends up to 20 s on lookups and 3 s on the preview after the read, so its read gets 5 s (5 + 20 + 3 < 30).
export const PRE_TOOL_DEADLINE_MS = 5_000;
export const EVENT_DEADLINE_MS = 5_000;
export const STOP_DEADLINE_MS = 10_000;
// A writer that pauses this long may have finished without closing stdin: only then is the buffer parsed.
export const IDLE_PARSE_MS = 50;
const size = (bytes) => bytes % (1024 * 1024) === 0
    ? `${String(bytes / (1024 * 1024))} MiB`
    : `${String(bytes)} bytes`;
// True when the last non-whitespace byte is `}`: only then can the buffer be a complete JSON object.
const endsWithBrace = (buf) => {
    for (let i = buf.length - 1; i >= 0; i--) {
        const b = buf[i];
        if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09)
            continue;
        return b === 0x7d;
    }
    return false;
};
export function readStdin(stream = process.stdin, { deadlineMs, maxBytes = STDIN_MAX_BYTES } = {
    deadlineMs: EVENT_DEADLINE_MS,
}) {
    return new Promise((resolve) => {
        try {
            if (stream.isTTY) {
                resolve({ ok: true, text: "" });
                return;
            }
            const chunks = [];
            let bytes = 0;
            let settled = false;
            let idle;
            let lastBrace = false;
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(idle);
                try {
                    stream.removeListener("data", onData);
                    stream.removeListener("end", onEnd);
                    stream.removeListener("error", onError);
                    // a late error must not crash the hook
                    stream.on("error", () => {
                        // ignored once the result is known
                    });
                    stream.pause();
                    stream.destroy?.();
                }
                catch {
                    // the result stands
                }
                resolve(result);
            };
            const text = () => Buffer.concat(chunks, bytes).toString("utf8");
            const onData = (chunk) => {
                const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                bytes += buf.length;
                if (bytes > maxBytes) {
                    finish({ ok: false, why: `input over ${size(maxBytes)}` });
                    return;
                }
                chunks.push(buf);
                // A harness may leave stdin open: once the writer pauses, a buffer that parses as a whole is complete (a prefix
                // of an object never parses). Never parsed per chunk, so brace-dense input stays linear.
                lastBrace = endsWithBrace(buf);
                clearTimeout(idle);
                idle = setTimeout(onIdle, IDLE_PARSE_MS);
            };
            const onIdle = () => {
                if (settled || !lastBrace)
                    return;
                const whole = text();
                try {
                    JSON.parse(whole);
                    finish({ ok: true, text: whole });
                }
                catch {
                    // more to come
                }
            };
            const onEnd = () => {
                finish({ ok: true, text: text() });
            };
            const onError = () => {
                finish({ ok: false, why: "input could not be read" });
            };
            const timer = setTimeout(() => {
                finish({
                    ok: false,
                    why: `input not complete within ${String(deadlineMs / 1000)} s`,
                });
            }, deadlineMs);
            stream.on("data", onData);
            stream.on("end", onEnd);
            stream.on("error", onError);
        }
        catch {
            resolve({ ok: false, why: "input could not be read" });
        }
    });
}
