import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emit,
  logRequest,
  otelOff,
  parsePairs,
  traceContext,
} from "./otel.mjs";
import type {
  EnvMap,
  OtelAttribute,
  OtelPayload,
  OtelRecord,
  SentRequest,
  TraceContext,
} from "./types.mjs";
function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing expected value");
  return value;
}

void test("parsePairs: comma pairs, percent-decoded, bad pairs skipped", () => {
  assert.deepEqual(parsePairs("Authorization=Bearer%20abc,x=1,junk,=no"), {
    Authorization: "Bearer abc",
    x: "1",
  });
  assert.deepEqual(parsePairs(undefined), {});
});

void test("logRequest: OTLP JSON record with the resource attributes and the event", () => {
  const r = logRequest(
    {
      endpoint: "https://otel.example/",
      headers: "Authorization=Bearer%20t",
      resource: "service.namespace=claude-code,host.name=mac",
    },
    "guard.decision",
    { rule: "pip-deny", action: "deny", skipped: undefined },
    1000,
  );
  assert.equal(defined(r).url, "https://otel.example/v1/logs");
  assert.equal(defined(r).headers.Authorization, "Bearer t");
  const rec = readOtel(defined(r).body).resourceLogs[0];
  const keys = (list: OtelAttribute[]) =>
    Object.fromEntries(list.map((a) => [a.key, a.value.stringValue]));
  assert.deepEqual(keys(defined(rec).resource.attributes), {
    "service.name": "guard",
    "service.namespace": "claude-code",
    "host.name": "mac",
  });
  const log = defined(defined(rec).scopeLogs[0]).logRecords[0];
  assert.equal(defined(log).timeUnixNano, "1000000000");
  assert.deepEqual(keys(defined(log).attributes), {
    "event.name": "guard.decision",
    rule: "pip-deny",
    action: "deny",
  });
});

void test("emit: no request without an endpoint; failures are swallowed", async () => {
  const never = () => assert.fail("must not send");
  await emit({}, "guard.decision", {}, never);
  let sent: Partial<SentRequest> = {};
  await emit(
    { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" },
    "guard.decision",
    { rule: "r" },
    (url, init) => (sent = { url, init }),
  );
  assert.equal(defined(sent).url, "http://c/v1/logs");
  assert.equal(defined(defined(sent).init).method, "POST");
  await emit(
    { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" },
    "guard.decision",
    {},
    () => {
      throw new Error("down");
    },
  );
});

void test("emit: GUARD_-prefixed copies stand in for the OTEL_* the harness stripped", async () => {
  let sent: Partial<SentRequest> = {};
  await emit(
    {
      GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g",
      GUARD_OTEL_EXPORTER_OTLP_HEADERS: "k=v",
    },
    "guard.decision",
    {},
    (url, init) => (sent = { url, init }),
  );
  assert.equal(defined(sent).url, "http://g/v1/logs");
  assert.equal(defined(defined(sent).init).headers.k, "v");
  await emit(
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://o",
      GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g",
    },
    "guard.decision",
    {},
    (url) => (sent = { url }),
  );
  assert.equal(defined(sent).url, "http://o/v1/logs");
});

void test("logRequest: a harness reported by the guard owns service.name and service.namespace", () => {
  const r = logRequest(
    {
      endpoint: "http://c",
      resource: "service.namespace=claude-code,host.name=mac",
    },
    "api_request",
    {},
    1,
    "pi",
  );
  const attrs = Object.fromEntries(
    defined(readOtel(defined(r).body).resourceLogs[0]).resource.attributes.map(
      (a) => [a.key, a.value.stringValue],
    ),
  );
  assert.deepEqual(attrs, {
    "service.namespace": "pi",
    "host.name": "mac",
    "service.name": "pi",
  });
});

void test("emit: GUARD_OTEL=off sends nothing, even with an endpoint", async () => {
  const never = () => assert.fail("must not send");
  for (const off of ["off", "OFF", "0", "false"])
    await emit(
      {
        GUARD_OTEL: off,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
        GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g",
      },
      "guard.decision",
      {},
      never,
    );
  assert.equal(otelOff({ GUARD_OTEL: "on" }), false);
  assert.equal(otelOff({}), false);
});

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
};

void test("traceContext: a well-formed GUARD_TRACEPARENT gives its trace and span ids", () => {
  assert.deepEqual(traceContext({ GUARD_TRACEPARENT: TP }), TRACE);
  assert.deepEqual(traceContext({ GUARD_TRACEPARENT: ` ${TP}\n` }), TRACE);
  assert.deepEqual(
    traceContext({ GUARD_TRACEPARENT: TP.replace(/01$/, "00") }),
    TRACE,
  );
});

void test("traceContext: absent, empty or malformed is no trace context", () => {
  const bad = [
    undefined,
    "",
    "   ",
    "garbage",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7", // flags missing
    "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01", // trace id one short
    "00-4bf92f3577b34da6a3ce929d0e0e47360-00f067aa0ba902b7-01", // trace id one long
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01", // span id one short
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1", // flags one short
    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01", // uppercase trace id
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00F067AA0BA902B7-01", // uppercase span id
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0A", // uppercase flags
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01", // all-zero trace id
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01", // all-zero span id
    "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // invalid version
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra", // version 00 takes no more fields
    "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01x", // a higher version: the 55 characters end in `-` or the value
    "0g-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // version not hex
    "1-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // version one short
    "FE-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // uppercase version
    "fe-00000000000000000000000000000000-00f067aa0ba902b7-01", // all-zero trace id under a higher version
    "00_4bf92f3577b34da6a3ce929d0e0e4736_00f067aa0ba902b7_01", // wrong separator
    `${TP}-extra`,
  ];
  for (const v of bad)
    assert.equal(
      traceContext(v === undefined ? {} : { GUARD_TRACEPARENT: v }),
      null,
      String(v),
    );
  assert.equal(traceContext(undefined), null);
});

void test("traceContext: a higher version is read by its first 55 characters (W3C), ff never", () => {
  const ids = "4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  for (const v of [
    `01-${ids}`,
    `01-${ids}-future`,
    `fe-${ids}-a-b-c`,
    `cc-${ids}-`,
  ])
    assert.deepEqual(traceContext({ GUARD_TRACEPARENT: v }), TRACE, v);
  for (const v of [`ff-${ids}`, `ff-${ids}-future`])
    assert.equal(traceContext({ GUARD_TRACEPARENT: v }), null, v);
});

void test("traceContext: only GUARD_TRACEPARENT, never TRACEPARENT or another source", () => {
  assert.equal(traceContext({ TRACEPARENT: TP, OTEL_TRACEPARENT: TP }), null);
});

void test("logRequest: a trace context sets the record traceId and spanId, never as attributes; none leaves both out", () => {
  const rec = (trace: TraceContext | null | undefined) =>
    defined(
      defined(
        readOtel(
          defined(
            logRequest(
              { endpoint: "http://c" },
              "guard.decision",
              { rule: "r" },
              1,
              "guard",
              trace,
            ),
          ).body,
        ).resourceLogs[0],
      ).scopeLogs[0],
    ).logRecords[0];
  const withTrace = rec(TRACE);
  assert.equal(defined(withTrace).traceId, TRACE.traceId);
  assert.equal(defined(withTrace).spanId, TRACE.spanId);
  assert.ok(
    !defined(withTrace).attributes.some((a) => /trace|span/.test(a.key)),
  );
  for (const none of [undefined, null]) {
    const r = rec(none);
    assert.ok(!("traceId" in defined(r)) && !("spanId" in defined(r)));
  }
});

void test("emit: guard.decision carries a well-formed GUARD_TRACEPARENT, other events and malformed values do not", async () => {
  const sent: OtelRecord[] = [];
  const send = (env: EnvMap, event: string) =>
    emit(
      { GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g", ...env },
      event,
      { rule: "r" },
      (_, init) =>
        sent.push(
          defined(
            defined(defined(readOtel(init.body).resourceLogs[0]).scopeLogs[0])
              .logRecords[0],
          ),
        ),
    );
  await send({ GUARD_TRACEPARENT: TP }, "guard.decision");
  await send({ GUARD_TRACEPARENT: TP.toUpperCase() }, "guard.decision");
  await send({}, "guard.decision");
  await send({ GUARD_TRACEPARENT: TP }, "guard.stop");
  assert.equal(sent.length, 4);
  assert.deepEqual(
    [defined(sent[0]).traceId, defined(sent[0]).spanId],
    [TRACE.traceId, TRACE.spanId],
  );
  for (const r of sent.slice(1))
    assert.ok(!("traceId" in r) && !("spanId" in r));
  // The raw value (version and flags) is never sent as such.
  assert.ok(!JSON.stringify(sent).includes(TP));
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function attributes(value: unknown): value is OtelAttribute[] {
  return (
    isList(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.key === "string" &&
        isRecord(item.value) &&
        typeof item.value.stringValue === "string",
    )
  );
}
function record(value: unknown): value is OtelRecord {
  return (
    isRecord(value) &&
    typeof value.timeUnixNano === "string" &&
    attributes(value.attributes) &&
    (value.traceId === undefined || typeof value.traceId === "string") &&
    (value.spanId === undefined || typeof value.spanId === "string")
  );
}
function payload(value: unknown): value is OtelPayload {
  return (
    isRecord(value) &&
    isList(value.resourceLogs) &&
    value.resourceLogs.every(
      (resource) =>
        isRecord(resource) &&
        isRecord(resource.resource) &&
        attributes(resource.resource.attributes) &&
        isList(resource.scopeLogs) &&
        resource.scopeLogs.every(
          (scope) =>
            isRecord(scope) &&
            isList(scope.logRecords) &&
            scope.logRecords.every(record),
        ),
    )
  );
}
function readOtel(body: string): OtelPayload {
  const value: unknown = JSON.parse(body);
  assert.ok(payload(value));
  return value;
}
