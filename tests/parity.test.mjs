import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliveries, gaps, HARNESSES, inventory } from '../scripts/parity.mjs'

const all = (skills, agents) => Object.fromEntries(HARNESSES.map((h) => [h, { skills: new Set(skills), agents: new Set(agents) }]))
const inv = { skills: [{ plugin: 'dev-tools', name: 'ship' }, { plugin: 'python', name: 'python-testing' }], agents: [{ plugin: 'dev-tools', name: 'scout' }] }

test('this repo: every skill and agent reaches every harness', () => {
  const found = inventory()
  assert.ok(found.skills.some((s) => s.name === 'ship') && found.agents.some((a) => a.name === 'scout'))
  assert.deepEqual(gaps(found, deliveries()), [])
})

test('a full delivery has no gaps', () => {
  assert.deepEqual(gaps(inv, all(['ship', 'python-testing'], ['scout'])), [])
})

test('a skill one harness misses is reported for that harness only', () => {
  const d = all(['ship', 'python-testing'], ['scout'])
  d.opencode.skills.delete('python-testing')
  assert.deepEqual(gaps(inv, d), ['skill python:python-testing: not delivered to opencode'])
})

test('an agent one harness misses is reported', () => {
  const d = all(['ship', 'python-testing'], ['scout'])
  d.pi.agents.clear()
  assert.deepEqual(gaps(inv, d), ['agent dev-tools:scout: not delivered to pi'])
})

test('a harness with no delivery at all reports everything', () => {
  const d = all(['ship', 'python-testing'], ['scout'])
  delete d.codex
  assert.equal(gaps(inv, d).filter((g) => g.endsWith('to codex')).length, 3)
})

test('the same skill name in two plugins is reported: opencode and pi flatten skills by name', () => {
  const dup = { skills: [...inv.skills, { plugin: 'api', name: 'ship' }], agents: [] }
  assert.match(gaps(dup, all(['ship', 'python-testing'], []))[0], /skill ship: in both dev-tools and api/)
})
