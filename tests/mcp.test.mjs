import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { renderMcp, syncMcp } from '../scripts/sync-mcp.mjs'

const source = (url = 'https://mcp.example.com/mcp') => ({ mcpServers: { docs: { type: 'http', url } } })
const fixture = (t, value = source()) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, '.mcp.json'), JSON.stringify(value))
  return root
}

test('one HTTP declaration reaches Codex TOML and pi JSON with identical endpoints', () => {
  const outputs = renderMcp(source())
  assert.equal(outputs[0].path, '.codex/config.toml')
  assert.match(outputs[0].content, /\[mcp_servers\."docs"\]\nurl = "https:\/\/mcp.example.com\/mcp"/)
  assert.deepEqual(JSON.parse(outputs[1].content).mcpServers, source().mcpServers)
})

test('account placeholders are resolved; other credential variables and absent account are rejected without values', () => {
  const declaration = source('https://mcp.${MCP_CONNECTOR_ACCOUNT}.example.com/mcp')
  const outputs = renderMcp(declaration, 'example-account')
  assert.equal(JSON.parse(outputs[1].content).mcpServers.docs.url, 'https://mcp.example-account.example.com/mcp')
  assert.throws(() => renderMcp(declaration), /MCP_CONNECTOR_ACCOUNT must be available/)
  assert.throws(() => renderMcp(declaration, 'private/value'), (error) => !error.message.includes('private/value'))
  for (const url of ['https://example.com/${API_TOKEN}', 'https://example.com/${BAD', 'https://example.com/$TOKEN'])
    assert.throws(() => renderMcp(source(url)), /Only the MCP_CONNECTOR_ACCOUNT/)
})

test('malformed and unsupported declarations fail instead of silently losing fields', () => {
  for (const value of [null, [], {}, { mcpServers: [] }, { mcpServers: {}, extra: true }, { mcpServers: { docs: null } },
    { mcpServers: { docs: { type: 'stdio', command: 'example' } } }, { mcpServers: { docs: { type: 'http', url: 'https://example.com', headers: {} } } }])
    assert.throws(() => renderMcp(value))
  for (const url of [null, '', 'invalid', 'file:///tmp/mcp', 'https://private-user:private-pass@example.com', 'https://example.com/?token=private-token', 'https://example.com/#private', 'https://example.com/a\nb', 'https:\\example.com'])
    assert.throws(() => renderMcp(source(url)), (error) => !/private-user|private-pass|private-token/.test(error.message))
})

test('cross-client names are checked and hyphen/underscore namespace clashes fail', () => {
  assert.throws(() => renderMcp({ mcpServers: { 'bad.name': { type: 'http', url: 'https://example.com' } } }), /server names/)
  assert.throws(() => renderMcp({ mcpServers: { 'a-b': source().mcpServers.docs, a_b: source().mcpServers.docs } }), /collide/)
  const servers = JSON.parse('{"__proto__":{"type":"http","url":"https://example.com"}}')
  assert.ok(Object.hasOwn(JSON.parse(renderMcp({ mcpServers: servers })[1].content).mcpServers, '__proto__'))
})

test('quoted paths are escaped in TOML and preserved in JSON; names are rendered in deterministic order', () => {
  const declaration = { mcpServers: { z: { type: 'http', url: 'https://example.com/a"b' }, a: source().mcpServers.docs } }
  const outputs = renderMcp(declaration)
  assert.match(outputs[0].content, /a\\"b/)
  assert.ok(outputs[0].content.indexOf('mcp_servers."a"') < outputs[0].content.indexOf('mcp_servers."z"'))
  assert.equal(JSON.parse(outputs[1].content).mcpServers.z.url, 'https://example.com/a"b')
})

test('local sync is idempotent, private-mode, and removes deleted servers from both outputs', (t) => {
  const root = fixture(t)
  syncMcp(root)
  const outputs = renderMcp(source())
  for (const output of outputs) assert.equal(readFileSync(join(root, output.path), 'utf8'), output.content)
  syncMcp(root)
  for (const output of outputs) {
    assert.equal(readFileSync(join(root, output.path), 'utf8'), output.content)
    if (process.platform !== 'win32') assert.equal(statSync(join(root, output.path)).mode & 0o777, 0o600)
  }
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
  syncMcp(root)
  assert.ok(!readFileSync(join(root, outputs[0].path), 'utf8').includes('[mcp_servers.'))
  assert.deepEqual(JSON.parse(readFileSync(join(root, outputs[1].path), 'utf8')).mcpServers, {})
})

test('all destinations are preflighted before writes and hand-authored native files are preserved', (t) => {
  for (const path of ['.codex/config.toml', '.pi/mcp.json']) {
    const root = fixture(t)
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), 'hand-authored')
    assert.throws(() => syncMcp(root), /Refusing to overwrite unowned/)
    assert.equal(readFileSync(join(root, path), 'utf8'), 'hand-authored')
    const other = path.startsWith('.pi') ? '.codex/config.toml' : '.pi/mcp.json'
    assert.equal(existsSync(join(root, other)), false)
  }
})

test('invalid JSON is reported without echoing source values', (t) => {
  const root = fixture(t)
  writeFileSync(join(root, '.mcp.json'), '{"private-value"')
  assert.throws(() => syncMcp(root), (error) => error.message === 'Cannot read .mcp.json as JSON')
})

test('--check validates conversion without an account environment or any native output files', (t) => {
  const root = fixture(t, source('https://mcp.${MCP_CONNECTOR_ACCOUNT}.example.com/mcp'))
  mkdirSync(join(root, 'scripts'))
  copyFileSync(new URL('../scripts/sync-mcp.mjs', import.meta.url), join(root, 'scripts/sync-mcp.mjs'))
  const env = { ...process.env }
  delete env.MCP_CONNECTOR_ACCOUNT
  const checked = spawnSync(process.execPath, [join(root, 'scripts/sync-mcp.mjs'), '--check'], { env, encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
  assert.equal(existsSync(join(root, '.codex')), false)
  assert.equal(existsSync(join(root, '.pi')), false)
  const generated = spawnSync(process.execPath, [join(root, 'scripts/sync-mcp.mjs')], { env, encoding: 'utf8' })
  assert.equal(generated.status, 1)
  assert.match(generated.stderr, /MCP_CONNECTOR_ACCOUNT must be available/)
  assert.equal(existsSync(join(root, '.codex')), false)
})

test('symlink destinations and parent directories cannot redirect writes', { skip: process.platform === 'win32' }, (t) => {
  const root = fixture(t)
  const outside = fixture(t)
  symlinkSync(outside, join(root, '.codex'))
  assert.throws(() => syncMcp(root), /symlink parent/)
  assert.equal(existsSync(join(outside, 'config.toml')), false)
  rmSync(join(root, '.codex'))
  mkdirSync(join(root, '.codex'))
  symlinkSync(join(outside, 'missing'), join(root, '.codex/config.toml'))
  assert.throws(() => syncMcp(root), /symlink/)
  assert.equal(existsSync(join(outside, 'missing')), false)
  rmSync(join(root, '.codex/config.toml'))
  symlinkSync(join(outside, 'missing-directory'), join(root, '.pi'))
  assert.throws(() => syncMcp(root), /symlink parent/)
  assert.equal(existsSync(join(root, '.codex/config.toml')), false)
})
