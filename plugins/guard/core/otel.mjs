// Guard decisions as OTLP/HTTP JSON log records, for the OTel collector the harness already exports to.
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; the headers (Bearer, Cloudflare Access) come from
// OTEL_EXPORTER_OTLP_HEADERS and are never logged. Every failure is swallowed: a decision never waits on telemetry.
// Claude Code and Copilot CLI strip OTEL_* from a command hook's environment, so each variable falls back
// to a GUARD_-prefixed copy (GUARD_OTEL_EXPORTER_OTLP_ENDPOINT, ...) that the launching shell exports.
// GUARD_OTEL=off (also 0, false) sends nothing, whatever the endpoint: probes and `make test` set it.
const TIMEOUT_MS = 2000

export const otelOff = (env) => /^(off|0|false)$/i.test(String(env?.GUARD_OTEL ?? '').trim())
// True when a record would be sent: an endpoint is set (OTEL_* or its GUARD_ copy) and the switch is not off.
export const otelEnabled = (env) => !otelOff(env) && Boolean(env?.OTEL_EXPORTER_OTLP_ENDPOINT || env?.GUARD_OTEL_EXPORTER_OTLP_ENDPOINT)

// `k=v,k=v` (percent-encoded values), as OTEL_EXPORTER_OTLP_HEADERS and OTEL_RESOURCE_ATTRIBUTES spell them.
export function parsePairs(str) {
  const out = {}
  for (const part of String(str ?? '').split(',')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      // malformed escape: skip the pair
    }
  }
  return out
}

// `owner/name` from a git remote URL, read by form: a `scheme://` URL's path (Azure's `<project>/_git/<repo>` gives
// `project/repo`), or the path after the colon of the scp form `[user@]host:owner/name`. At least two path segments,
// the last two taken, `.git` dropped; never a host, port, user or token. Null for a local path, `file://`, a relative
// remote or anything else, since their segments are local directory names.
const SLUG_SEGMENT = /^(?!\.+$)[\w.-]+$/
export function repoSlug(url) {
  const s = String(url ?? '').trim()
  let path
  if (/^[a-z][\w+.-]*:\/\//i.test(s)) {
    if (/^file:/i.test(s)) return null
    try {
      path = new URL(s).pathname
    } catch {
      return null
    }
  } else {
    const m = /^(?:[^@\s/:]+@)?([^\s/:]+):(?!\/)(\S+)$/.exec(s)
    if (!m || /^[a-z]$/i.test(m[1])) return null
    path = m[2]
  }
  let segs = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean)
  const azure = segs.indexOf('_git')
  if (azure > 0) segs = [segs[azure - 1], segs[azure + 1]]
  segs = segs.slice(-2)
  return segs.length === 2 && segs.every((x) => SLUG_SEGMENT.test(x ?? '')) ? segs.join('/') : null
}

const attr = (key, value) => ({ key, value: { stringValue: String(value) } })

// `config` is the raw env values: { endpoint, headers, resource }. `service` other than guard is a harness the
// guard reports for (opencode, pi: no native telemetry), so it owns service.name and service.namespace.
export function logRequest({ endpoint, headers, resource }, event, attrs, now = Date.now(), service = 'guard') {
  if (!endpoint) return null
  const res = service === 'guard' ? { 'service.name': 'guard', ...parsePairs(resource) } : { ...parsePairs(resource), 'service.name': service, 'service.namespace': service }
  return {
    url: `${endpoint.replace(/\/+$/, '')}/v1/logs`,
    headers: { 'content-type': 'application/json', ...parsePairs(headers) },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: Object.entries(res).map(([k, v]) => attr(k, v)) },
          scopeLogs: [
            {
              scope: { name: 'guard' },
              logRecords: [
                {
                  timeUnixNano: String(BigInt(now) * 1_000_000n),
                  severityText: 'INFO',
                  body: { stringValue: event },
                  attributes: [attr('event.name', event), ...Object.entries(attrs).filter(([, v]) => v != null).map(([k, v]) => attr(k, v))],
                },
              ],
            },
          ],
        },
      ],
    }),
  }
}

export async function emit(env, event, attrs, fetchFn = fetch, service = 'guard') {
  try {
    if (otelOff(env)) return
    const v = (k) => env[k] || env[`GUARD_${k}`]
    const req = logRequest({ endpoint: v('OTEL_EXPORTER_OTLP_ENDPOINT'), headers: v('OTEL_EXPORTER_OTLP_HEADERS'), resource: v('OTEL_RESOURCE_ATTRIBUTES') }, event, attrs, Date.now(), service)
    if (req) await fetchFn(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    // collector unreachable or slow: the decision stands
  }
}
