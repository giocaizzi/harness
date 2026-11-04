import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCommand } from "./engine.mjs";
import { cpuPercentFrom, hostCaps, parseDfFreeGb, parseLoad1, parseWindows, } from "./host.mjs";
import { rules } from "./rules.mjs";
void test("load average: macOS and Linux formats", () => {
    assert.equal(parseLoad1("14:02  up 3 days,  4 users,  load averages: 1.62 2.48 2.67"), 1.62);
    assert.equal(parseLoad1(" 14:02:11 up 3 days, load average: 0.52, 0.58, 0.59"), 0.52);
    assert.equal(parseLoad1("garbage"), undefined);
});
void test("df -k / available space, macOS and Linux layouts", () => {
    assert.equal(parseDfFreeGb("Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s1s1 971350180 11024 150994944 8% 1 2 0% /"), 144);
    assert.equal(parseDfFreeGb("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 50 10485760 50% /"), 10);
    assert.equal(parseDfFreeGb(""), undefined);
});
void test("Windows probe output", () => {
    assert.deepEqual(parseWindows("37 214748364800\r\n"), {
        cpuPercent: 37,
        freeGb: 200,
    });
    assert.deepEqual(parseWindows(" 214748364800"), {
        cpuPercent: 214748364800,
        freeGb: undefined,
    });
    assert.deepEqual(parseWindows("x y"), {
        cpuPercent: undefined,
        freeGb: undefined,
    });
});
void test("cpu percent from two snapshots", () => {
    const snap = (idle, busy) => [
        { times: { idle, user: busy, sys: 0, nice: 0, irq: 0 } },
    ];
    assert.equal(cpuPercentFrom(snap(100, 100), snap(150, 250)), 75);
    assert.equal(cpuPercentFrom(snap(100, 100), snap(100, 100)), undefined);
});
const defaults = rules.host;
void test("hostCaps: defaults without an environment", () => {
    for (const env of [undefined, {}]) {
        assert.deepEqual(hostCaps(env, defaults), {
            loadCap: defaults.loadCap,
            cpuPercentCap: defaults.cpuPercentCap,
            freeFloorGb: defaults.freeFloorGb,
            off: false,
        });
    }
});
void test("hostCaps: each variable overrides its own cap, decimals included", () => {
    const load = hostCaps({ GUARD_HOST_LOAD_CAP: "100" }, defaults);
    assert.equal(load.loadCap, 100);
    assert.equal(load.cpuPercentCap, defaults.cpuPercentCap);
    assert.equal(load.freeFloorGb, defaults.freeFloorGb);
    const cpu = hostCaps({ GUARD_HOST_CPU_CAP: " 99 " }, defaults);
    assert.equal(cpu.cpuPercentCap, 99);
    assert.equal(cpu.loadCap, defaults.loadCap);
    const disk = hostCaps({ GUARD_HOST_DISK_FLOOR_GB: "12.5" }, defaults);
    assert.equal(disk.freeFloorGb, 12.5);
    assert.equal(disk.cpuPercentCap, defaults.cpuPercentCap);
});
void test("hostCaps: an invalid value keeps the default", () => {
    for (const bad of [
        "",
        "  ",
        "0",
        "-5",
        "abc",
        "NaN",
        "Infinity",
        "1e3",
        "0x10",
        "30abc",
    ]) {
        assert.deepEqual(hostCaps({
            GUARD_HOST_LOAD_CAP: bad,
            GUARD_HOST_CPU_CAP: bad,
            GUARD_HOST_DISK_FLOOR_GB: bad,
        }, defaults), hostCaps({}, defaults), JSON.stringify(bad));
    }
});
void test("hostCaps: only the exact string off turns the rule off", () => {
    assert.equal(hostCaps({ GUARD_HOST_CHECK: "off" }, defaults).off, true);
    for (const v of ["OFF", "0", "false", "", "on"]) {
        assert.equal(hostCaps({ GUARD_HOST_CHECK: v }, defaults).off, false, v);
    }
});
void test("engine: raised caps let a heavy command through on a strained host", () => {
    const run = (host, over) => evaluateCommand({
        command: "npm run build",
        state: { reminded: new Set() },
        host,
        rules: { ...rules, host: { ...rules.host, ...over } },
    });
    const cases = [
        [{ load1: 50, freeGb: 100 }, { loadCap: 100 }],
        [{ load1: 2, freeGb: 5 }, { freeFloorGb: 1 }],
        [{ cpuPercent: 95, freeGb: 100 }, { cpuPercentCap: 99 }],
    ];
    for (const [host, over] of cases) {
        const denied = run(host, {});
        assert.equal(denied.action, "deny");
        assert.equal(denied.rule, "host");
        assert.notEqual(run(host, over).rule, "host");
    }
});
