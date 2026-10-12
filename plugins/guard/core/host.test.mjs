import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpuPercentFrom, parseDfFreeGb, parseLoad1, parseWindows } from './host.mjs'

test('load average: macOS and Linux formats', () => {
  assert.equal(parseLoad1('14:02  up 3 days,  4 users,  load averages: 1.62 2.48 2.67'), 1.62)
  assert.equal(parseLoad1(' 14:02:11 up 3 days, load average: 0.52, 0.58, 0.59'), 0.52)
  assert.equal(parseLoad1('garbage'), undefined)
})

test('df -k / available space, macOS and Linux layouts', () => {
  assert.equal(parseDfFreeGb('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s1s1 971350180 11024 150994944 8% 1 2 0% /'), 144)
  assert.equal(parseDfFreeGb('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 50 10485760 50% /'), 10)
  assert.equal(parseDfFreeGb(''), undefined)
})

test('Windows probe output', () => {
  assert.deepEqual(parseWindows('37 214748364800\r\n'), { cpuPercent: 37, freeGb: 200 })
  assert.deepEqual(parseWindows(' 214748364800'), { cpuPercent: 214748364800, freeGb: undefined })
  assert.deepEqual(parseWindows('x y'), { cpuPercent: undefined, freeGb: undefined })
})

test('cpu percent from two snapshots', () => {
  const snap = (idle, busy) => [{ times: { idle, user: busy, sys: 0, nice: 0, irq: 0 } }]
  assert.equal(cpuPercentFrom(snap(100, 100), snap(150, 250)), 75)
  assert.equal(cpuPercentFrom(snap(100, 100), snap(100, 100)), undefined)
})
