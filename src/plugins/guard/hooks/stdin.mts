// Reads a hook's payload from stdin without ever truncating it silently: the caller learns whether the whole payload
// arrived, so a hook can fail closed on a partial read instead of judging half a tool call.

export const STDIN_MAX_BYTES = 32 * 1024 * 1024;
// A PreToolUse hook is killed at 30 s, the other guard events at 10 s; the readers stop well before that.
export const PRE_TOOL_DEADLINE_MS = 10_000;
export const EVENT_DEADLINE_MS = 5_000;
export const STOP_DEADLINE_MS = 10_000;

export type StdinResult =
  { ok: true; text: string } | { ok: false; why: string };

export interface ReadStdinOptions {
  deadlineMs: number;
  maxBytes?: number;
}

const size = (bytes: number): string =>
  bytes % (1024 * 1024) === 0
    ? `${String(bytes / (1024 * 1024))} MiB`
    : `${String(bytes)} bytes`;

// True when the last non-whitespace byte is `}`: only then can the buffer be a complete JSON object.
const endsWithBrace = (buf: Buffer): boolean => {
  for (let i = buf.length - 1; i >= 0; i--) {
    const b = buf[i];
    if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) continue;
    return b === 0x7d;
  }
  return false;
};

export function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  { deadlineMs, maxBytes = STDIN_MAX_BYTES }: ReadStdinOptions = {
    deadlineMs: EVENT_DEADLINE_MS,
  },
): Promise<StdinResult> {
  return new Promise((resolve) => {
    try {
      if ((stream as { isTTY?: boolean }).isTTY) {
        resolve({ ok: true, text: "" });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;

      const finish = (result: StdinResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          stream.removeListener("data", onData);
          stream.removeListener("end", onEnd);
          stream.removeListener("error", onError);
          // a late error must not crash the hook
          stream.on("error", () => {
            // ignored once the result is known
          });
          stream.pause();
          (stream as { destroy?: () => void }).destroy?.();
        } catch {
          // the result stands
        }
        resolve(result);
      };

      const text = (): string => Buffer.concat(chunks, bytes).toString("utf8");

      const onData = (chunk: Buffer | string): void => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytes += buf.length;
        if (bytes > maxBytes) {
          finish({ ok: false, why: `input over ${size(maxBytes)}` });
          return;
        }
        chunks.push(buf);
        // A harness may leave stdin open: a buffer that parses as a whole is complete (a prefix of an object never parses).
        if (endsWithBrace(buf)) {
          const whole = text();
          try {
            JSON.parse(whole);
            finish({ ok: true, text: whole });
          } catch {
            // more to come
          }
        }
      };
      const onEnd = (): void => {
        finish({ ok: true, text: text() });
      };
      const onError = (): void => {
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
    } catch {
      resolve({ ok: false, why: "input could not be read" });
    }
  });
}
