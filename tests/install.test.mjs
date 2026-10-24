import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../scripts/install.mjs'

test('codex: every generated agent lands in agents/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-codex-'))
  install('codex', dir)
  for (const agent of ['scout', 'escalate', 'api-reviewer']) assert.ok(existsSync(join(dir, 'agents', `${agent}.toml`)), agent)
})

test('opencode: skills, agents and a plugin stub that points at this checkout; stale items are removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-opencode-'))
  mkdirSync(join(dir, 'skills', 'gone'), { recursive: true })
  writeFileSync(join(dir, '.giocaizzi-harness.json'), JSON.stringify(['skills/gone']))
  install('opencode', dir)
  assert.ok(existsSync(join(dir, 'skills', 'ship', 'SKILL.md')))
  assert.ok(existsSync(join(dir, 'agents', 'scout.md')))
  assert.match(readFileSync(join(dir, 'plugins', 'giocaizzi-guard.js'), 'utf8'), /export \* from "file:.*plugins\/guard\/hooks\/opencode\.mjs"/)
  assert.match(readFileSync(join(dir, 'plugins', 'giocaizzi-sounds.js'), 'utf8'), /export \* from "file:.*plugins\/sounds\/hooks\/opencode\.mjs"/)
  assert.ok(!existsSync(join(dir, 'skills', 'gone')))
})

test("opencode: hud's TUI plugin is merged into tui.json, keeping the user's settings; one that is not JSON is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-opencode-tui-'))
  writeFileSync(join(dir, 'tui.json'), JSON.stringify({ theme: 'tokyonight', plugin: ['npm-thing', 'file:///old/checkout/plugins/hud/hooks/opencode-tui.mjs'] }))
  install('opencode', dir)
  install('opencode', dir)
  const config = JSON.parse(readFileSync(join(dir, 'tui.json'), 'utf8'))
  assert.equal(config.theme, 'tokyonight')
  assert.equal(config.plugin.length, 2)
  assert.equal(config.plugin[0], 'npm-thing')
  assert.match(config.plugin[1], /^file:.*plugins\/hud\/hooks\/opencode-tui\.mjs$/)
  assert.ok(existsSync(new URL(config.plugin[1])))
  const fresh = mkdtempSync(join(tmpdir(), 'install-opencode-tui-'))
  install('opencode', fresh)
  assert.deepEqual(JSON.parse(readFileSync(join(fresh, 'tui.json'), 'utf8')).plugin.length, 1)
  writeFileSync(join(fresh, 'tui.json'), '{ // mine\n}')
  install('opencode', fresh)
  assert.equal(readFileSync(join(fresh, 'tui.json'), 'utf8'), '{ // mine\n}')
})
