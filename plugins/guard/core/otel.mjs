// Guard decisions as OTLP/HTTP JSON log records, for the OTel collector the harness already exports to.
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; the headers (Bearer, Cloudflare Access) come from
// OTEL_EXPORTER_OTLP_HEADERS and are never logged. Every failure is swallowed: a decision never waits on telemetry.
const TIMEOUT_MS = 2000

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

const attr = (key, value) => ({ key, value: { stringValue: String(value) } })

// `config` is the raw env values: { endpoint, headers, resource }.
export function logRequest({ endpoint, headers, resource }, event, attrs, now = Date.now()) {
  if (!endpoint) return null
  const res = { 'service.name': 'guard', ...parsePairs(resource) }
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

export async function emit(env, event, attrs, fetchFn = fetch) {
  try {
    const req = logRequest({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, headers: env.OTEL_EXPORTER_OTLP_HEADERS, resource: env.OTEL_RESOURCE_ATTRIBUTES }, event, attrs)
    if (req) await fetchFn(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    // collector unreachable or slow: the decision stands
  }
}
