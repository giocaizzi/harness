import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repoOf } from './links.mjs'
import { unmark } from './markup.mjs'
import { ago, commitUrl, createFacts, DEFAULTS, editorUrl, fetchState, fileGlyph, GLYPH, local, resolvePath, rewrite, settings, shortPath, shortUrl, summary } from './rewrite.mjs'

process.env.TZ = 'UTC' // times are drawn local

const GH = repoOf('git@github.com:o/r.git')
const GL = repoOf('https://gitlab.com/group/proj.git')
const AZ = repoOf('https://dev.azure.com/acme/web/_git/site')
const NOW = Date.parse('2026-10-14T02:00:00Z')

// A filesystem: paths that exist (dirs end with /), the rest missing.
const FS = ['/home/me/', '/home/me/.zshrc', '/home/me/code/r/.git/', '/home/me/code/r/src/', '/home/me/code/r/src/app.ts', '/home/me/code/r/src/__init__.py', '/home/me/code/r/.claude/worktrees/wt/.git', '/home/me/code/r/.claude/worktrees/wt/src/app.ts', '/tmp/x/notes.md', 'C:/Users/me/code/q/.git/', 'C:/Users/me/code/q/main.go']
const fsStat = async (p) => (FS.includes(p) ? 'file' : FS.includes(`${p}/`) ? 'dir' : null)

// Rewrites with every lookup settled first: { text: without colour marks, raw: with them }.
async function go(text, { opts = {}, env = {}, colour = true, ctx = {}, commits = [], states = {} } = {}) {
  const facts = createFacts({ stat: fsStat, commit: async (sha) => commits.includes(sha), state: async (_r, ref) => states[`${ref.sigil}${ref.n}`] ?? null })
  const o = settings({ replyTimes: 'off', ...opts }, env, colour)
  const c = { repo: GH, cwd: '/home/me/code/r', home: '/home/me', now: NOW, ...ctx }
  for (let i = 0; i < 3; i++) {
    rewrite(text, o, c, facts)
    await facts.settle()
  }
  const raw = rewrite(text, o, c, facts)
  return { raw, text: unmark(raw) }
}
const only = (feature, extra = {}) => ({ ...Object.fromEntries(Object.keys(DEFAULTS).filter((k) => k.startsWith('reply')).map((k) => [k, 'off'])), [feature]: 'on', ...extra })
const plain = { glyphs: false, colour: false }

test('settings: defaults, per-feature modes, NO_COLOR and a harness without colour', () => {
  const o = settings()
  assert.deepEqual(o.f.replyPaths, { glyph: true, colour: true })
  assert.equal(o.editor, 'vscode')
  assert.equal(settings({ replyPaths: 'off' }).f.replyPaths, null)
  assert.equal(settings({ replyPaths: false }).f.replyPaths, null)
  assert.deepEqual(settings({ replyPaths: 'no-glyph' }).f.replyPaths, { glyph: false, colour: true })
  assert.deepEqual(settings({ replyPaths: 'no-colour' }).f.replyPaths, { glyph: true, colour: false })
  assert.deepEqual(settings({ replyPaths: 'plain' }).f.replyPaths, { glyph: false, colour: false })
  assert.deepEqual(settings({ glyphs: false }).f.replyUrls, { glyph: false, colour: true })
  assert.deepEqual(settings({ colour: false }).f.replyUrls, { glyph: true, colour: false })
  assert.deepEqual(settings({}, { NO_COLOR: '1' }).f.replyUrls, { glyph: false, colour: false })
  assert.deepEqual(settings({}, { NO_COLOR: '' }).f.replyUrls, { glyph: true, colour: true })
  assert.deepEqual(settings({}, {}, false).f.replyUrls, { glyph: true, colour: false })
  assert.deepEqual(settings({ replyUrls: undefined }).f.replyUrls, { glyph: true, colour: true })
})

test('secrets: the prefix stays, the rest is masked, in code too; look-alikes are left', async () => {
  const keys = {
    'ghp_abcdefghijklmnopqrstuvwx1234': 'ghp_',
    'gho_abcdefghijklmnopqrstuvwx1234': 'gho_',
    'ghs_abcdefghijklmnopqrstuvwx1234': 'ghs_',
    'github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz': 'github_pat_',
    'sk-ant-api03-abcDEF123456789_xyz-0': 'sk-ant-',
    'sk-proj-abcdefghij1234567890KLMNOP': 'sk-proj-',
    'sk-abcdefghij1234567890KLMNOPqrst': 'sk-',
    AKIAIOSFODNN7EXAMPLE: 'AKIA',
    'xoxb-1234567890-abcdefghij': 'xoxb-',
    'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc123': 'Bearer ',
  }
  for (const [key, prefix] of Object.entries(keys)) {
    const { text } = await go(`token ${key} here`, { opts: { ...only('replySecrets'), ...plain } })
    assert.equal(text, `token ${prefix}•••••••• here`, key)
  }
  // Glyph and colour in prose; plain in code and URLs, where a mark could not be drawn.
  const { raw, text } = await go('k ghp_abcdefghijklmnopqrstuvwx1234 `ghp_abcdefghijklmnopqrstuvwx1234`\n```\nexport T=sk-ant-api03-abcDEF123456789_xyz-0\n```\nhttps://x.io/?t=ghp_abcdefghijklmnopqrstuvwx1234', { opts: only('replySecrets') })
  assert.equal(text, `k ${GLYPH.lock} ghp_•••••••• \`ghp_••••••••\`\n\`\`\`\nexport T=sk-ant-••••••••\n\`\`\`\nhttps://x.io/?t=ghp_••••••••`)
  assert.match(raw, /\uFDD0secret\uFDD1\uf023 ghp_\uFDD2\uFDD0dim\uFDD1••••••••\uFDD2/)
  const pem = ['-----BEGIN RSA PRIVATE', 'KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----'].join(' ') // split: no scanner flags the fixture
  assert.equal((await go(pem, { opts: only('replySecrets') })).text, '-----BEGIN RSA PRIVATE KEY-----\n••••••••\n-----END RSA PRIVATE KEY-----')
  for (const fine of ['use sk-learn-and-other-libraries-for-models', 'the ghp_ prefix', 'Bearer token auth', 'AKIA is AWS', 'sk-ant-short1', 'task-abcdefghijklmnopqrstu1234']) {
    assert.equal((await go(fine, { opts: only('replySecrets') })).text, fine, fine)
  }
})

test('secrets off: left as written', async () => {
  const t = 'ghp_abcdefghijklmnopqrstuvwx1234'
  assert.equal((await go(t, { opts: { replySecrets: 'off', replyUrls: 'off', replyRefs: 'off', replyCommits: 'off' } })).text, t)
})

test('shortUrl: forge URLs as references, others as host and a short path', () => {
  assert.deepEqual(shortUrl('https://github.com/x/y/pull/12', GH), { label: 'x/y#12', kind: 'pr', forge: 'github' })
  assert.deepEqual(shortUrl('https://github.com/o/r/issues/7', GH), { label: '#7', kind: 'issue', forge: 'github' })
  assert.equal(shortUrl('https://github.com/x/y/commit/e1500fb1234567', GH).label, 'y@e1500fb')
  assert.equal(shortUrl('https://github.com/x/y/blob/main/src/a.ts#L12', GH).label, 'y › src/a.ts:12')
  assert.equal(shortUrl('https://github.com/x/y/tree/main/docs', GH).label, 'y › docs')
  assert.equal(shortUrl('https://github.com/x/y', GH).label, 'x/y')
  assert.deepEqual(shortUrl('https://gitlab.com/g/sub/p/-/merge_requests/4', GH), { label: 'g/sub/p!4', kind: 'pr', forge: 'gitlab' })
  assert.equal(shortUrl('https://gitlab.com/group/proj/-/issues/9', GL).label, '#9')
  assert.equal(shortUrl('https://gitlab.com/g/p/-/commit/abcdef123456', GH).label, 'p@abcdef1')
  assert.equal(shortUrl('https://gitlab.com/g/p/-/blob/main/x/y.py#L3', GH).label, 'p › x/y.py:3')
  assert.deepEqual(shortUrl('https://dev.azure.com/acme/web/_git/site/pullrequest/31', AZ), { label: 'site!31', kind: 'pr', forge: 'azure' })
  assert.equal(shortUrl('https://dev.azure.com/acme/web/_workitems/edit/77', AZ).label, 'AB#77')
  assert.equal(shortUrl('https://dev.azure.com/acme/web/_git/site/commit/abcdef1234', AZ).label, 'site@abcdef1')
  assert.equal(shortUrl('https://dev.azure.com/acme/web/_git/site?path=/src/a.cs&line=5', AZ).label, 'site › src/a.cs:5')
  assert.equal(shortUrl('https://www.example.com/docs/guide/v2/install/linux.html?x=1#y', GH).label, 'example.com/docs/…/linux.html')
  assert.equal(shortUrl('https://example.com/a', GH), null) // short already
  assert.equal(shortUrl('ftp://example.com/a/very/long/path/to/some/file.tar.gz', GH), null)
  assert.equal(shortUrl('not a url', GH), null)
})

test('URLs: bare, autolink and self-labelled links shortened, the target kept; chosen labels and code left', async () => {
  const o = { opts: { ...only('replyUrls'), ...plain } }
  assert.equal((await go('see https://github.com/x/y/pull/12.', o)).text, 'see [x/y#12](https://github.com/x/y/pull/12).')
  assert.equal((await go('see <https://github.com/x/y/pull/12>', o)).text, 'see [x/y#12](https://github.com/x/y/pull/12)')
  assert.equal((await go('[https://github.com/x/y/pull/12](https://github.com/x/y/pull/12)', o)).text, '[x/y#12](https://github.com/x/y/pull/12)')
  for (const fine of ['[the PR](https://github.com/x/y/pull/12)', '`https://github.com/x/y/pull/12`', '```\nhttps://github.com/x/y/pull/12\n```', 'https://example.com/a']) {
    assert.equal((await go(fine, o)).text, fine, fine)
  }
  const { raw } = await go('https://github.com/x/y/pull/12', { opts: only('replyUrls') })
  assert.equal(unmark(raw), `[${GLYPH.github} x/y#12](https://github.com/x/y/pull/12)`)
  assert.match(raw, /\uFDD0pr\uFDD1/)
  assert.match((await go('https://gitlab.com/g/p/-/issues/1', { opts: only('replyUrls') })).text, new RegExp(GLYPH.gitlab))
  assert.match((await go('https://dev.azure.com/acme/web/_workitems/edit/7', { opts: only('replyUrls') })).text, new RegExp(GLYPH.azure))
  assert.match((await go('https://example.com/docs/guide/v2/install/linux.html', { opts: only('replyUrls') })).text, new RegExp(GLYPH.globe))
})

test('work-item references: links, with the state glyph and colour once it is known', async () => {
  const states = { '#1': { kind: 'issue', state: 'open' }, '#2': { kind: 'pr', state: 'merged' }, '#3': { kind: 'issue', state: 'closed' }, '#4': { kind: 'pr', state: 'draft' }, '#5': { kind: 'pr', state: 'closed' } }
  const { raw, text } = await go('#1 #2 #3 #4 #5 #6', { opts: only('replyRefs', { replyState: 'on' }), states })
  assert.equal(text, '[\uf41b #1](https://github.com/o/r/issues/1) [\uf419 #2](https://github.com/o/r/issues/2) [\uf41d #3](https://github.com/o/r/issues/3) [\uf4dd #4](https://github.com/o/r/issues/4) [\uf4dc #5](https://github.com/o/r/issues/5) [\uf41b #6](https://github.com/o/r/issues/6)')
  for (const s of ['open', 'merged', 'closed', 'draft']) assert.match(raw, new RegExp(`\uFDD0${s}\uFDD1`))
  assert.match(raw, /\uFDD0issue\uFDD1\uf41b #6/) // unknown state: the kind's glyph and colour
  // Without state lookups: the kind glyph; plain: the bare link, as links.mjs writes it.
  assert.equal((await go('#2', { opts: only('replyRefs'), states })).text, '[\uf41b #2](https://github.com/o/r/issues/2)')
  assert.equal((await go('#2', { opts: { ...only('replyRefs'), ...plain }, states })).text, '[#2](https://github.com/o/r/issues/2)')
  assert.equal((await go('no repo #2', { opts: only('replyRefs'), ctx: { repo: null } })).text, 'no repo #2')
  for (const fine of ['`#2`', 'x#2', '#fff', 'C#7', '[#2](https://e.x/2)', 'see https://e.x/#2']) assert.equal((await go(fine, { opts: { ...only('replyRefs'), ...plain } })).text, fine, fine)
})

test('fetchState: GitHub, GitLab and Azure DevOps CLI answers', async () => {
  const runs = []
  const run = (out) => async (argv) => (runs.push(argv.join(' ')), JSON.stringify(out))
  assert.deepEqual(await fetchState(run({ state: 'open' }), GH, { sigil: '#', n: '1' }), { kind: 'issue', state: 'open' })
  assert.equal(runs.at(-1), 'gh api --hostname github.com repos/o/r/issues/1')
  assert.deepEqual(await fetchState(run({ state: 'closed', pull_request: { merged_at: '2026-01-01' } }), GH, { repo: 'x/y', sigil: '#', n: '2' }), { kind: 'pr', state: 'merged' })
  assert.equal(runs.at(-1), 'gh api --hostname github.com repos/x/y/issues/2')
  assert.deepEqual(await fetchState(run({ state: 'open', draft: true, pull_request: {} }), GH, { sigil: '#', n: '3' }), { kind: 'pr', state: 'draft' })
  assert.deepEqual(await fetchState(run({ state: 'closed', pull_request: { merged_at: null } }), GH, { sigil: '#', n: '3' }), { kind: 'pr', state: 'closed' })
  assert.deepEqual(await fetchState(run({ state: 'merged' }), GL, { sigil: '!', n: '4' }), { kind: 'pr', state: 'merged' })
  assert.equal(runs.at(-1), 'glab api --hostname gitlab.com projects/group%2Fproj/merge_requests/4')
  assert.deepEqual(await fetchState(run({ state: 'opened', draft: true }), GL, { sigil: '!', n: '4' }), { kind: 'pr', state: 'draft' })
  assert.deepEqual(await fetchState(run({ state: 'opened' }), GL, { sigil: '#', n: '5' }), { kind: 'issue', state: 'open' })
  assert.deepEqual(await fetchState(run({ status: 'completed' }), AZ, { sigil: '!', n: '6' }), { kind: 'pr', state: 'merged' })
  assert.equal(runs.at(-1), 'az repos pr show --id 6 --org https://dev.azure.com/acme --output json')
  assert.deepEqual(await fetchState(run({ status: 'active', isDraft: true }), AZ, { sigil: '!', n: '6' }), { kind: 'pr', state: 'draft' })
  assert.deepEqual(await fetchState(run({ fields: { 'System.State': 'Done' } }), AZ, { sigil: 'AB#', n: '7' }), { kind: 'workitem', state: 'closed' })
  assert.deepEqual(await fetchState(run({ fields: { 'System.State': 'Active' } }), AZ, { sigil: '#', n: '7' }), { kind: 'workitem', state: 'open' })
  assert.equal(await fetchState(async () => null, GH, { sigil: '#', n: '1' }), null) // no gh, no auth
  assert.equal(await fetchState(async () => 'not json', GH, { sigil: '#', n: '1' }), null)
})

test('resolvePath, shortPath and the editor URL', () => {
  assert.equal(resolvePath('src/a.ts', { cwd: '/r' }), '/r/src/a.ts')
  assert.equal(resolvePath('../b/./c.ts', { cwd: '/r/x' }), '/r/b/c.ts')
  assert.equal(resolvePath('~/x/y', { home: '/home/me' }), '/home/me/x/y')
  assert.equal(resolvePath('C:\\Users\\me\\a.go', {}), 'C:/Users/me/a.go')
  assert.equal(resolvePath('src\\a.ts', { cwd: 'C:\\r' }), 'C:/r/src/a.ts')
  assert.deepEqual(shortPath('/c/r/src/a.ts', '/c/r', '/home'), { prefix: 'r › src/', name: 'a.ts' })
  assert.deepEqual(shortPath('/c/r/a.ts', '/c/r', '/home'), { prefix: 'r › ', name: 'a.ts' })
  assert.deepEqual(shortPath('/c/r/.claude/worktrees/wt/src/a.ts', '/c/r/.claude/worktrees/wt', '/'), { prefix: 'r[wt] › src/', name: 'a.ts' })
  assert.deepEqual(shortPath('/home/me/notes/a.md', null, '/home/me'), { prefix: '~/notes/', name: 'a.md' })
  assert.deepEqual(shortPath('C:/Users/Me/x.txt', null, 'C:\\Users\\me'), { prefix: '~/', name: 'x.txt' })
  assert.deepEqual(shortPath('/etc/hosts', null, '/home/me'), { prefix: '/etc/', name: 'hosts' })
  assert.equal(editorUrl('/a b/c.ts', 12, 3), 'vscode://file/a%20b/c.ts:12:3')
  assert.equal(editorUrl('/a/c.ts'), 'vscode://file/a/c.ts:1:1')
  assert.equal(editorUrl('C:/a/c.ts', 2, null), 'vscode://file/C:/a/c.ts:2:1')
  assert.equal(editorUrl('/a/c.ts', 2, 1, { editor: 'cursor' }), 'cursor://file/a/c.ts:2:1')
  assert.equal(editorUrl('/a/c.ts', 2, 1, { editor: 'zed' }), 'zed://file/a/c.ts:2:1')
  assert.equal(editorUrl('/a/c.ts', 2, 4, { editor: 'idea' }), 'idea://open?file=/a/c.ts&line=2&column=4')
  assert.equal(editorUrl('/a/c.ts', 2, 4, { editor: 'sublime' }), 'subl://open?url=file:///a/c.ts&line=2&column=4')
  assert.equal(editorUrl('/a/c.ts', 2, 4, { editor: 'file' }), 'file:///a/c.ts')
  assert.equal(editorUrl('/a/c.ts', 2, 4, { editor: 'custom', editorUrl: 'nvim://open?f={path}&l={line}' }), 'nvim://open?f=/a/c.ts&l=2')
  assert.equal(editorUrl('/a/c.ts', 2, 4, { editor: 'custom', editorUrl: '' }), 'vscode://file/a/c.ts:2:4')
  assert.equal(fileGlyph('a.ts', 'file'), '\ue628')
  assert.equal(fileGlyph('A.PY', 'file'), '\ue73c')
  assert.equal(fileGlyph('LICENSE', 'file'), GLYPH.file)
  assert.equal(fileGlyph('src', 'dir'), GLYPH.dir)
})

test('paths: shortened under a repo, a worktree, home; linked to the editor; only when they exist', async () => {
  const o = { opts: { ...only('replyPaths', { replyFileLinks: 'on' }), ...plain } }
  assert.equal((await go('Edited /home/me/code/r/src/app.ts:12.', o)).text, 'Edited [r › src/app.ts:12](vscode://file/home/me/code/r/src/app.ts:12:1).')
  assert.equal((await go('see /home/me/code/r/.claude/worktrees/wt/src/app.ts:3:9', o)).text, 'see [r\\[wt\\] › src/app.ts:3:9](vscode://file/home/me/code/r/.claude/worktrees/wt/src/app.ts:3:9)')
  assert.equal((await go('see /home/me/.zshrc', o)).text, 'see [~/.zshrc](vscode://file/home/me/.zshrc:1:1)')
  assert.equal((await go('see ~/.zshrc', o)).text, 'see [~/.zshrc](vscode://file/home/me/.zshrc:1:1)')
  assert.equal((await go('see /tmp/x/notes.md', o)).text, 'see [/tmp/x/notes.md](vscode://file/tmp/x/notes.md:1:1)')
  assert.equal((await go('dir /home/me/code/r/src/', o)).text, 'dir [r › src](file:///home/me/code/r/src)')
  assert.equal((await go('py /home/me/code/r/src/__init__.py', o)).text, 'py [r › src/\\_\\_init\\_\\_.py](vscode://file/home/me/code/r/src/__init__.py:1:1)')
  assert.equal((await go('at src/app.ts:40:2 and ./src/app.ts:1', o)).text, 'at [src/app.ts:40:2](vscode://file/home/me/code/r/src/app.ts:40:2) and [./src/app.ts:1](vscode://file/home/me/code/r/src/app.ts:1:1)')
  assert.equal((await go('win C:\\Users\\me\\code\\q\\main.go:7', { ...o, ctx: { home: 'C:\\Users\\me' } })).text, 'win [q › main.go:7](vscode://file/C:/Users/me/code/q/main.go:7:1)')
  // Missing files, code, links, URLs and look-alikes stay as written.
  for (const fine of ['/home/me/code/r/src/gone.ts:3', 'gone.ts:3', '`/home/me/code/r/src/app.ts`', '[x](/home/me/code/r/src/app.ts)', 'https://e.x/home/me/code/r/src/app.ts', 'and/or', '10/14/2026', 'example.com:443', '127.0.0.1:8080', '$HOME/code/r/src/app.ts', '/tmp', 'src/app.ts']) {
    assert.equal((await go(fine, o)).text, fine, fine)
  }
  // Paths without links; links without shortening.
  assert.equal((await go('/home/me/code/r/src/app.ts', { opts: { ...only('replyPaths'), ...plain } })).text, 'r › src/app.ts')
  assert.equal((await go('/home/me/code/r/src/app.ts', { opts: { ...only('replyFileLinks'), ...plain } })).text, '[/home/me/code/r/src/app.ts](vscode://file/home/me/code/r/src/app.ts:1:1)')
  assert.equal((await go('/home/me/code/r/src/app.ts', { opts: { ...only('replyPaths', { replyFileLinks: 'on', editor: 'zed' }), ...plain } })).text, '[r › src/app.ts](zed://file/home/me/code/r/src/app.ts:1:1)')
})

test('paths in colour: a file-type glyph, the prefix dim, the name bold, the line in its colour; an editor glyph with a line', async () => {
  const { raw } = await go('/home/me/code/r/src/app.ts:12', { opts: only('replyPaths', { replyFileLinks: 'on' }) })
  assert.equal(raw, `[\uf44f \uFDD0dim\uFDD1r › src/\uFDD2\uFDD0name\uFDD1app.ts\uFDD2\uFDD0line\uFDD1:12\uFDD2](vscode://file/home/me/code/r/src/app.ts:12:1)`)
  assert.match((await go('/home/me/code/r/src/app.ts', { opts: only('replyPaths') })).raw, /^\ue628 /)
})

test('commits: only real commits of the session repository, linked to the forge', async () => {
  const commits = ['e1500fb', 'e1500fb1234567890abcdef1234567890abcdef']
  const o = { opts: { ...only('replyCommits'), ...plain }, commits }
  assert.equal((await go('in e1500fb.', o)).text, 'in [e1500fb](https://github.com/o/r/commit/e1500fb).')
  assert.equal((await go('e1500fb1234567890abcdef1234567890abcdef', o)).text, '[e1500fb1234567890abcdef1234567890abcdef](https://github.com/o/r/commit/e1500fb1234567890abcdef1234567890abcdef)')
  assert.equal((await go('e1500fb', { ...o, ctx: { repo: null } })).text, 'e1500fb') // a commit, but no forge: as written
  for (const fine of ['abc1234', '`e1500fb`', '#e1500fb', 'deadbeef', '1234567', '550e8400-e29b', 'x/e1500fb', 'e1500fbz']) assert.equal((await go(fine, o)).text, fine, fine)
  const { raw } = await go('e1500fb', { opts: only('replyCommits'), commits })
  assert.equal(raw, '[\uFDD0sha\uFDD1\uf417 e1500fb\uFDD2](https://github.com/o/r/commit/e1500fb)')
  assert.equal(commitUrl(GL, 'abc'), 'https://gitlab.com/group/proj/-/commit/abc')
  assert.equal(commitUrl(AZ, 'abc'), 'https://dev.azure.com/acme/web/_git/site/commit/abc')
})

test('times: local, how long ago, in three formats; look-alikes left', async () => {
  assert.equal(ago(NOW - 45_000, NOW), '45s ago')
  assert.equal(ago(NOW - 5 * 3600_000, NOW), '5h ago')
  assert.equal(ago(NOW + 2 * 3600_000, NOW), 'in 2h')
  assert.equal(ago(NOW - 3 * 86400_000, NOW), '3d ago')
  assert.equal(local(Date.parse('2026-10-13T20:56:00Z'), NOW), '13 Oct 20:56')
  assert.equal(local(Date.parse('2024-01-02T03:04:00Z'), NOW), '2 Jan 2024 03:04')
  const o = (timeFormat, extra = plain) => ({ opts: { ...only('replyTimes'), ...extra, timeFormat } })
  assert.equal((await go('at 2026-10-13T20:56:00Z.', o('both'))).text, 'at 13 Oct 20:56 (5h ago).')
  assert.equal((await go('at 2026-10-13T22:56:00+02:00', o('absolute'))).text, 'at 13 Oct 20:56')
  assert.equal((await go('at 2026-10-13T20:56:00.123Z', o('relative'))).text, 'at 5h ago')
  assert.equal((await go('at 2026-10-13 20:56', o('both'))).text, 'at 13 Oct 20:56 (5h ago)')
  const { raw } = await go('2026-10-13T20:56Z', o('both', {}))
  assert.equal(raw, `${GLYPH.clock} \uFDD0time\uFDD113 Oct 20:56\uFDD2 \uFDD0dim\uFDD1(5h ago)\uFDD2`)
  for (const fine of ['2026-10-13', '`2026-10-13T20:56:00Z`', 'v2026-10-13T20:56', '2026-13-40T20:56:00Z']) assert.equal((await go(fine, o('both'))).text, fine, fine)
})

test('pass/fail: table cells, list items and name: status lines with counts; prose left', async () => {
  const o = { opts: { ...only('replyStatus'), glyphs: true, colour: false } }
  const table = '| check | result |\n|---|---|\n| lint | ✅ |\n| test | failed |\n| e2e | skipped |'
  assert.equal((await go(table, o)).text, '| check | result |\n|---|---|\n| lint | ✓ |\n| test | ✗ failed |\n| e2e | ⊘ skipped |\n\n1 ✓ · 1 ✗ · 1 ⊘')
  const list = '- lint: passed\n- `test` — FAILED\n- e2e (skipped)\n- ✓ build\n- PASS docs'
  assert.equal((await go(list, o)).text, '- lint: ✓ passed\n- `test` — ✗ FAILED\n- e2e (⊘ skipped)\n- ✓ build\n- ✓ PASS docs\n\n3 ✓ · 1 ✗ · 1 ⊘')
  assert.equal((await go('Result: ok', o)).text, 'Result: ✓ ok')
  // One status: no counts. Prose, code, headings: left.
  assert.equal((await go('- lint: passed', o)).text, '- lint: ✓ passed')
  for (const fine of ['The tests passed.', '- All tests passed today', '- Pass the token to the client', '- fail fast is a principle', '```\n- lint: passed\n```', 'It is ok to merge.', '| a | b |\n|---|---|\n| x | the build failed |']) {
    assert.equal((await go(fine, o)).text, fine, fine)
  }
  // Colour without glyphs: the word coloured; a symbol stays a symbol.
  const { raw } = await go('- lint: passed\n- test: ✗', { opts: { ...only('replyStatus'), glyphs: false } })
  assert.equal(raw, '- lint: \uFDD0ok\uFDD1passed\uFDD2\n- test: \uFDD0bad\uFDD1✗\uFDD2\n\n\uFDD0ok\uFDD11 ✓\uFDD2 · \uFDD0bad\uFDD11 ✗\uFDD2')
  assert.equal(summary({ ok: 12, bad: 1, skip: 0 }, { colour: false }), '12 ✓ · 1 ✗')
})

test('the pipeline: every feature at once, and fenced code untouched', async () => {
  const text = 'Merged #2 (e1500fb) touching /home/me/code/r/src/app.ts:3 — lint: passed\n\n```\n#2 e1500fb /home/me/code/r/src/app.ts:3\n```'
  const { text: out } = await go(text, { opts: { ...plain, replyTimes: 'on' }, commits: ['e1500fb'], states: { '#2': { kind: 'pr', state: 'merged' } } })
  assert.equal(out, 'Merged [#2](https://github.com/o/r/issues/2) ([e1500fb](https://github.com/o/r/commit/e1500fb)) touching [r › src/app.ts:3](vscode://file/home/me/code/r/src/app.ts:3:1) — lint: passed\n\n```\n#2 e1500fb /home/me/code/r/src/app.ts:3\n```')
  // Not settled yet: drawn as written, never waited for.
  const facts = createFacts({ stat: () => new Promise(() => {}), commit: () => new Promise(() => {}) })
  assert.equal(rewrite('e1500fb /home/me/code/r/src/app.ts', settings(plain), { repo: GH, cwd: '/', home: '/home/me', now: NOW }, facts), 'e1500fb /home/me/code/r/src/app.ts')
  assert.ok(facts.pending > 0)
  assert.equal(rewrite('', settings(), {}, facts), '')
})

test('createFacts: one lookup per key, undefined until known, a failing reader is null', async () => {
  let calls = 0
  const f = createFacts({ stat: async () => (calls++, 'file'), commit: async () => { throw new Error('no git') } })
  assert.equal(f.stat('/a'), undefined)
  assert.equal(f.stat('/a'), undefined)
  assert.equal(f.commit('abc1234'), undefined)
  assert.equal(await f.settle(), true)
  assert.equal(f.stat('/a'), 'file')
  assert.equal(f.commit('abc1234'), null)
  assert.equal(calls, 1)
  assert.equal(await f.settle(), false)
  const slow = createFacts({ stat: () => new Promise(() => {}) })
  slow.stat('/x')
  assert.equal(await slow.settle(10), true) // gives up after the timeout
  assert.equal(slow.stat('/x'), undefined)
})
