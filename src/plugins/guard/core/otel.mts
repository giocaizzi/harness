// Guard decisions as OTLP/HTTP JSON log records, for the OTel collector the harness already exports to.
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; the headers (Bearer, Cloudflare Access) come from
// OTEL_EXPORTER_OTLP_HEADERS and are never logged. Every failure is swallowed: a decision never waits on telemetry.
// Claude Code and Copilot CLI strip OTEL_* from a command hook's environment, so each variable falls back
// to a GUARD_-prefixed copy (GUARD_OTEL_EXPORTER_OTLP_ENDPOINT, ...) that the launching shell exports.
// GUARD_OTEL=off (also 0, false) sends nothing, whatever the endpoint: probes and `make test` set it.

import { OTEL_TIMEOUT_MS } from "./constants.mjs";
import type {
  EnvMap,
  FetchLike,
  OtelConfig,
  OtelLogRequest,
  TraceContext,
} from "./types.mjs";

/** Return true when `GUARD_OTEL` disables telemetry (`off`, `0`, or `false`). */
export const otelOff = (env: EnvMap | null | undefined): boolean =>
  /^(off|0|false)$/i.test((env?.GUARD_OTEL ?? "").trim());

/** Return true when an OTLP endpoint is configured and telemetry is not disabled. */
export const otelEnabled = (env: EnvMap | null | undefined): boolean =>
  !otelOff(env) &&
  Boolean(
    env?.OTEL_EXPORTER_OTLP_ENDPOINT ?? env?.GUARD_OTEL_EXPORTER_OTLP_ENDPOINT,
  );

/** Parse comma-separated `k=v` pairs with percent-encoded values. */
export function parsePairs(
  str: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (str ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(
        part.slice(i + 1).trim(),
      );
    } catch {
      // malformed escape: skip the pair
    }
  }
  return out;
}

// `owner/name` from a git remote URL, read by form: a `scheme://` URL's path (Azure's `<project>/_git/<repo>` gives
// `project/repo`), or the path after the colon of the scp form `[user@]host:owner/name`. At least two path segments,
// the last two taken, `.git` dropped; never a host, port, user or token. Null for a local path, `file://`, a relative
// remote or anything else, since their segments are local directory names.
const SLUG_SEGMENT = /^(?!\.+$)[\w.-]+$/;

/** Extract `owner/name` from a git remote URL, or return null for local paths. */
export function repoSlug(url: string | null | undefined): string | null {
  const s = (url ?? "").trim();
  let path: string;
  if (/^[a-z][\w+.-]*:\/\//i.test(s)) {
    if (/^file:/i.test(s)) return null;
    try {
      path = new URL(s).pathname;
    } catch {
      return null;
    }
  } else {
    const m = /^(?:[^@\s/:]+@)?([^\s/:]+):(?!\/)(\S+)$/.exec(s);
    if (!m?.[1] || !m[2] || /^[a-z]$/i.test(m[1])) return null;
    path = m[2];
  }
  let segs: (string | undefined)[] = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const azure = segs.indexOf("_git");
  if (azure > 0) segs = [segs[azure - 1], segs[azure + 1]];
  segs = segs.slice(-2);
  const first = segs[0];
  const second = segs[1];
  return segs.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    SLUG_SEGMENT.test(first) &&
    SLUG_SEGMENT.test(second)
    ? `${first}/${second}`
    : null;
}

// The trace context a runtime gives the run in GUARD_TRACEPARENT, a W3C traceparent
// (`<2 hex version>-<32 hex trace id>-<16 hex span id>-<2 hex flags>`, lowercase): { traceId, spanId }, or null when it
// is absent, malformed or names an all-zero id. Version 00 is exactly that; a higher version is read by its first 55
// characters when they end the value or a `-` follows (W3C's forward compatibility), and version ff is invalid. Only
// that variable (harnesses strip TRACEPARENT and OTEL_* from hooks); the guard never derives one or starts spans of
// its own.
const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}(-[^]*)?$/;

/** Parse `GUARD_TRACEPARENT` into a W3C `{ traceId, spanId }` context, or null when absent or invalid. */
export function traceContext(
  env: EnvMap | null | undefined,
): TraceContext | null {
  const m = TRACEPARENT.exec((env?.GUARD_TRACEPARENT ?? "").trim());
  const version = m?.[1];
  const traceId = m?.[2];
  const spanId = m?.[3];
  if (
    !version ||
    !traceId ||
    !spanId ||
    version === "ff" ||
    (version === "00" && m[4] !== undefined) ||
    /^0+$/.test(traceId) ||
    /^0+$/.test(spanId)
  )
    return null;
  return { traceId, spanId };
}

const attr = (key: string, value: unknown) => ({
  key,
  value: { stringValue: String(value) },
});

/** Build an OTLP/HTTP JSON log request payload, or return null when no endpoint is set. */
export function logRequest(
  { endpoint, headers, resource }: OtelConfig,
  event: string,
  attrs: Record<string, unknown>,
  now = Date.now(),
  service = "guard",
  trace: TraceContext | null = null,
): OtelLogRequest | null {
  if (!endpoint) return null;
  const res =
    service === "guard"
      ? { "service.name": "guard", ...parsePairs(resource) }
      : {
          ...parsePairs(resource),
          "service.name": service,
          "service.namespace": service,
        };
  return {
    url: `${endpoint.replace(/\/+$/, "")}/v1/logs`,
    headers: {
      "content-type": "application/json",
      ...parsePairs(headers),
    },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: Object.entries(res).map(([k, v]) => attr(k, v)),
          },
          scopeLogs: [
            {
              scope: { name: "guard" },
              logRecords: [
                {
                  timeUnixNano: String(BigInt(now) * 1_000_000n),
                  ...(trace
                    ? { traceId: trace.traceId, spanId: trace.spanId }
                    : {}),
                  severityText: "INFO",
                  body: { stringValue: event },
                  attributes: [
                    attr("event.name", event),
                    ...Object.entries(attrs)
                      .filter(([, v]) => v != null)
                      .map(([k, v]) => attr(k, v)),
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  };
}

/** Emit an OTLP log record asynchronously, swallowing any network or timeout error. */
export async function emit(
  env: EnvMap | null | undefined,
  event: string,
  attrs: Record<string, unknown>,
  fetchFn: FetchLike = fetch,
  service = "guard",
): Promise<void> {
  try {
    if (!env || otelOff(env)) return;
    const v = (k: string): string | undefined => {
      const val = env[k];
      return val !== undefined && val !== "" ? val : env[`GUARD_${k}`];
    };
    const req = logRequest(
      {
        endpoint: v("OTEL_EXPORTER_OTLP_ENDPOINT"),
        headers: v("OTEL_EXPORTER_OTLP_HEADERS"),
        resource: v("OTEL_RESOURCE_ATTRIBUTES"),
      },
      event,
      attrs,
      Date.now(),
      service,
      event === "guard.decision" ? traceContext(env) : null,
    );
    if (req)
      await fetchFn(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(OTEL_TIMEOUT_MS),
      });
  } catch {
    // collector unreachable or slow: the decision stands
  }
}
