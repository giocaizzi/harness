import assert from "node:assert/strict";
import { test } from "node:test";
import { emit, logRequest, normalizeHostName, otelOff, parsePairs, traceContext, } from "./otel.mjs";
function defined(value) {
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
    const r = logRequest({
        endpoint: "https://otel.example/",
        headers: "Authorization=Bearer%20t",
        resource: "service.name=configured,service.namespace=claude-code,host.name=runner.example.test.",
    }, "guard.decision", { rule: "pip-deny", action: "deny", skipped: undefined }, 1000);
    assert.equal(defined(r).url, "https://otel.example/v1/logs");
    assert.equal(defined(r).headers.Authorization, "Bearer t");
    const rec = readOtel(defined(r).body).resourceLogs[0];
    const keys = (list) => Object.fromEntries(list.map((a) => [a.key, a.value.stringValue]));
    assert.deepEqual(keys(defined(rec).resource.attributes), {
        "service.name": "guard",
        "service.namespace": "claude-code",
        "host.name": "runner",
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
    let sent = {};
    await emit({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" }, "guard.decision", { rule: "r" }, (url, init) => (sent = { url, init }));
    assert.equal(defined(sent).url, "http://c/v1/logs");
    assert.equal(defined(defined(sent).init).method, "POST");
    await emit({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" }, "guard.decision", {}, () => {
        throw new Error("down");
    });
});
void test("emit: GUARD_-prefixed copies stand in for the OTEL_* the harness stripped", async () => {
    let sent = {};
    await emit({
        GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g",
        GUARD_OTEL_EXPORTER_OTLP_HEADERS: "k=v",
    }, "guard.decision", {}, (url, init) => (sent = { url, init }));
    assert.equal(defined(sent).url, "http://g/v1/logs");
    assert.equal(defined(defined(sent).init).headers.k, "v");
    await emit({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://o",
        GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g",
    }, "guard.decision", {}, (url) => (sent = { url }));
    assert.equal(defined(sent).url, "http://o/v1/logs");
});
void test("normalizeHostName: shortens DNS names, preserves IPs and omits absent hosts", () => {
    assert.equal(normalizeHostName(" runner.example.test. \n"), "runner");
    assert.equal(normalizeHostName("runner"), "runner");
    assert.equal(normalizeHostName("127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeHostName("2001:db8::1"), "2001:db8::1");
    assert.equal(normalizeHostName("localhost."), "localhost");
    assert.equal(normalizeHostName("  "), null);
    assert.equal(normalizeHostName(undefined), null);
    const request = logRequest({ endpoint: "http://collector.example", resource: "deployment=test" }, "guard.stop", {}, 1);
    const attrs = defined(readOtel(defined(request).body).resourceLogs[0])
        .resource.attributes;
    assert.ok(!attrs.some((item) => item.key === "host.name"));
});
void test("logRequest: a synthetic service owns service.name and service.namespace", () => {
    const r = logRequest({
        endpoint: "http://c",
        resource: "service.name=configured,service.namespace=configured,host.name=runner.example.test",
    }, "api_request", {}, 1, "pi");
    const attrs = Object.fromEntries(defined(readOtel(defined(r).body).resourceLogs[0]).resource.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.deepEqual(attrs, {
        "service.namespace": "pi",
        "host.name": "runner",
        "service.name": "pi",
    });
});
void test("emit: GUARD_OTEL=off sends nothing, even with an endpoint", async () => {
    const never = () => assert.fail("must not send");
    for (const off of ["off", "OFF", "0", "false"])
        await emit({
            GUARD_OTEL: off,
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
            GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g",
        }, "guard.decision", {}, never);
    assert.equal(otelOff({ GUARD_OTEL: "on" }), false);
    assert.equal(otelOff({}), false);
});
const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE = {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
};
void test("emit: Factory resource attributes survive service overrides and trace correlation", async () => {
    const resource = [
        "service.name=acme-runner",
        "service.namespace=claude-code",
        "factory.run_id=run-123",
        "factory.ticket=42",
        "factory.role=worker",
        "factory.phase=implementation",
        "factory.mode=attended",
        "host.name=runner.example.test.",
    ].join(",");
    const cases = [
        { service: "guard", namespace: "claude-code" },
        { service: "pi", namespace: "pi" },
    ];
    for (const expected of cases) {
        let sent;
        await emit({
            GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example",
            GUARD_OTEL_RESOURCE_ATTRIBUTES: resource,
            GUARD_TRACEPARENT: TP,
        }, "guard.decision", { rule: "factory-contract" }, (_, init) => {
            sent = readOtel(init.body);
        }, expected.service);
        const resourceLog = defined(defined(sent).resourceLogs[0]);
        const resourceAttrs = Object.fromEntries(resourceLog.resource.attributes.map((item) => [
            item.key,
            item.value.stringValue,
        ]));
        assert.deepEqual(resourceAttrs, {
            "service.name": expected.service,
            "service.namespace": expected.namespace,
            "factory.run_id": "run-123",
            "factory.ticket": "42",
            "factory.role": "worker",
            "factory.phase": "implementation",
            "factory.mode": "attended",
            "host.name": "runner",
        });
        const record = defined(defined(resourceLog.scopeLogs[0]).logRecords[0]);
        assert.equal(record.traceId, TRACE.traceId);
        assert.equal(record.spanId, TRACE.spanId);
        assert.deepEqual(Object.fromEntries(record.attributes.map((item) => [item.key, item.value.stringValue])), {
            "event.name": "guard.decision",
            rule: "factory-contract",
        });
    }
});
void test("traceContext: a well-formed GUARD_TRACEPARENT gives its trace and span ids", () => {
    assert.deepEqual(traceContext({ GUARD_TRACEPARENT: TP }), TRACE);
    assert.deepEqual(traceContext({ GUARD_TRACEPARENT: ` ${TP}\n` }), TRACE);
    assert.deepEqual(traceContext({ GUARD_TRACEPARENT: TP.replace(/01$/, "00") }), TRACE);
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
        assert.equal(traceContext(v === undefined ? {} : { GUARD_TRACEPARENT: v }), null, String(v));
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
    const rec = (trace) => defined(defined(readOtel(defined(logRequest({ endpoint: "http://c" }, "guard.decision", { rule: "r" }, 1, "guard", trace)).body).resourceLogs[0]).scopeLogs[0]).logRecords[0];
    const withTrace = rec(TRACE);
    assert.equal(defined(withTrace).traceId, TRACE.traceId);
    assert.equal(defined(withTrace).spanId, TRACE.spanId);
    assert.ok(!defined(withTrace).attributes.some((a) => /trace|span/.test(a.key)));
    for (const none of [undefined, null]) {
        const r = rec(none);
        assert.ok(!("traceId" in defined(r)) && !("spanId" in defined(r)));
    }
});
void test("emit: every event carries a well-formed GUARD_TRACEPARENT; malformed or absent values do not", async () => {
    const sent = [];
    const send = (env, event, service = "guard") => emit({ GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g", ...env }, event, { rule: "r" }, (_, init) => sent.push(defined(defined(defined(readOtel(init.body).resourceLogs[0]).scopeLogs[0])
        .logRecords[0])), service);
    await send({ GUARD_TRACEPARENT: TP }, "guard.decision");
    await send({ GUARD_TRACEPARENT: TP.toUpperCase() }, "guard.decision");
    await send({}, "guard.decision");
    await send({ GUARD_TRACEPARENT: TP }, "api_request", "pi");
    assert.equal(sent.length, 4);
    for (const index of [0, 3]) {
        assert.deepEqual([defined(sent[index]).traceId, defined(sent[index]).spanId], [TRACE.traceId, TRACE.spanId]);
    }
    for (const index of [1, 2]) {
        const record = defined(sent[index]);
        assert.ok(!("traceId" in record) && !("spanId" in record));
    }
    // The raw value (version and flags) is never sent as such.
    assert.ok(!JSON.stringify(sent).includes(TP));
});
void test("emit: a guard.decision keeps tool_use_id as an attribute and the trace ids as traceId/spanId", async () => {
    let sent;
    await emit({
        GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://g",
        GUARD_TRACEPARENT: TP,
    }, "guard.decision", { rule: "r", tool_use_id: "toolu_1" }, (_, init) => {
        sent = defined(defined(defined(readOtel(init.body).resourceLogs[0]).scopeLogs[0])
            .logRecords[0]);
    });
    const record = defined(sent);
    assert.deepEqual([record.traceId, record.spanId], [TRACE.traceId, TRACE.spanId]);
    const keys = record.attributes.map((a) => a.key);
    assert.ok(keys.includes("tool_use_id"));
    assert.deepEqual(record.attributes.find((a) => a.key === "tool_use_id")?.value, { stringValue: "toolu_1" });
    assert.ok(!keys.includes("trace_id") && !keys.includes("span_id"));
});
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isList(value) {
    return Array.isArray(value);
}
function attributes(value) {
    return (isList(value) &&
        value.every((item) => isRecord(item) &&
            typeof item.key === "string" &&
            isRecord(item.value) &&
            typeof item.value.stringValue === "string"));
}
function record(value) {
    return (isRecord(value) &&
        typeof value.timeUnixNano === "string" &&
        attributes(value.attributes) &&
        (value.traceId === undefined || typeof value.traceId === "string") &&
        (value.spanId === undefined || typeof value.spanId === "string"));
}
function payload(value) {
    return (isRecord(value) &&
        isList(value.resourceLogs) &&
        value.resourceLogs.every((resource) => isRecord(resource) &&
            isRecord(resource.resource) &&
            attributes(resource.resource.attributes) &&
            isList(resource.scopeLogs) &&
            resource.scopeLogs.every((scope) => isRecord(scope) &&
                isList(scope.logRecords) &&
                scope.logRecords.every(record))));
}
function readOtel(body) {
    const value = JSON.parse(body);
    assert.ok(payload(value));
    return value;
}
