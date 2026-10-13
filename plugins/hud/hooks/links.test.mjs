import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KIND, linkify, linkRepo, pickRemote, repoOf, styled } from './links.mjs'

const GH = 'git@github.com:giocaizzi/harness.git'
const GL = 'https://gitlab.com/group/sub/proj.git'
const AZ = 'https://acme@dev.azure.com/acme/Web%20App/_git/site'
const md = (text, remote = GH) => linkify(text, remote)

test('repoOf reads every remote form', () => {
  assert.deepEqual(repoOf('git@github.com:o/r.git'), { forge: 'github', host: 'github.com', path: 'o/r' })
  assert.deepEqual(repoOf('https://github.com/o/r'), { forge: 'github', host: 'github.com', path: 'o/r' })
  assert.deepEqual(repoOf('ssh://git@github.com:22/o/r.git/'), { forge: 'github', host: 'github.com', path: 'o/r' })
  assert.deepEqual(repoOf('https://github.acme.io/o/r.git'), { forge: 'github', host: 'github.acme.io', path: 'o/r' })
  assert.deepEqual(repoOf(GL), { forge: 'gitlab', host: 'gitlab.com', path: 'group/sub/proj' })
  assert.deepEqual(repoOf('git@gitlab.acme.io:g/p.git'), { forge: 'gitlab', host: 'gitlab.acme.io', path: 'g/p' })
  assert.deepEqual(repoOf(AZ), { forge: 'azure', org: 'acme', project: 'Web%20App', repo: 'site' })
  assert.deepEqual(repoOf('git@ssh.dev.azure.com:v3/acme/proj/site'), { forge: 'azure', org: 'acme', project: 'proj', repo: 'site' })
  assert.deepEqual(repoOf('https://acme.visualstudio.com/DefaultCollection/proj/_git/site'), { forge: 'azure', org: 'acme', project: 'proj', repo: 'site' })
  assert.equal(repoOf('https://bitbucket.org/o/r.git'), null)
  assert.equal(repoOf('https://dev.azure.com/acme/proj'), null)
  assert.equal(repoOf(''), null)
  assert.equal(repoOf(null), null)
})

test('pickRemote: upstream, else origin, else the first', () => {
  assert.equal(pickRemote('origin\nupstream\n'), 'upstream')
  assert.equal(pickRemote('fork\norigin\n'), 'origin')
  assert.equal(pickRemote('mine\nother\n'), 'mine')
  assert.equal(pickRemote(''), null)
  assert.equal(pickRemote(null), null)
})

test('linkRepo reads the picked remote; owner/repo refs keep its host', async () => {
  const out = { 'git remote': 'origin\nupstream\n', 'git remote get-url upstream': 'https://github.acme.io/parent/r.git\n', 'git remote get-url origin': 'git@github.acme.io:me/r.git\n' }
  const r = await linkRepo(async (argv) => out[argv.join(' ')] ?? null)
  assert.deepEqual(r, { forge: 'github', host: 'github.acme.io', path: 'parent/r' })
  assert.equal(linkify('#1 and x/y#2', r), '[#1](https://github.acme.io/parent/r/issues/1) and [x/y#2](https://github.acme.io/x/y/issues/2)')
  assert.equal(await linkRepo(async () => null), null) // not a repository
})

test('GitHub: #N and owner/repo#N link to issues (GitHub redirects a PR)', () => {
  assert.equal(md('fixed in #123.'), 'fixed in [#123](https://github.com/giocaizzi/harness/issues/123).')
  assert.equal(md('see cli/cli#12'), 'see [cli/cli#12](https://github.com/cli/cli/issues/12)')
  assert.equal(md('(#1) and #2, #3'), '([#1](https://github.com/giocaizzi/harness/issues/1)) and [#2](https://github.com/giocaizzi/harness/issues/2), [#3](https://github.com/giocaizzi/harness/issues/3)')
  assert.equal(md('#7 opens a line'), '[#7](https://github.com/giocaizzi/harness/issues/7) opens a line')
  assert.equal(md('PR #9', 'https://github.acme.io/o/r'), 'PR [#9](https://github.acme.io/o/r/issues/9)')
  // GitHub has no !N or AB#N it can resolve, nor a deeper path
  assert.equal(md('!45 and AB#77 and docs/a/b#3'), '!45 and AB#77 and docs/a/b#3')
})

test('GitLab: #N issues, !N merge requests, group/proj refs', () => {
  assert.equal(md('#4 and !5', GL), '[#4](https://gitlab.com/group/sub/proj/-/issues/4) and [!5](https://gitlab.com/group/sub/proj/-/merge_requests/5)')
  assert.equal(md('other/proj!6 and a/b/c#7', GL), '[other/proj!6](https://gitlab.com/other/proj/-/merge_requests/6) and [a/b/c#7](https://gitlab.com/a/b/c/-/issues/7)')
})

test('Azure DevOps: #N and AB#N work items, !N pull requests', () => {
  assert.equal(md('#8, AB#9 and !10', AZ), '[#8](https://dev.azure.com/acme/Web%20App/_workitems/edit/8), [AB#9](https://dev.azure.com/acme/Web%20App/_workitems/edit/9) and [!10](https://dev.azure.com/acme/Web%20App/_git/site/pullrequest/10)')
  assert.equal(md('o/r#3 and AB!4', AZ), 'o/r#3 and AB!4')
})

test('false positives are left alone', () => {
  const same = [
    'colour #fff and #1a2b3c',
    '#!/usr/bin/env bash',
    '# Heading',
    '## Heading 2',
    'x#12 and a/#12 and &#123; and C#7',
    'https://github.com/o/r/pull/3#12 and <https://x.io/#4>',
    'github.com/o/r#12',
    '`#12` and ``a `#13` b``',
    'a [link #5](https://x.io) here',
    'v1.2#3 and #12abc and #1-2',
    'Wow!45 and a@b#3',
  ]
  for (const s of same) assert.equal(md(s), s, s)
})

test('fenced code is left alone, and the text after the fence is not', () => {
  const text = ['before #1', '```bash', 'echo #2', '```', '~~~', '#3', '~~~', 'after #4'].join('\n')
  const out = md(text).split('\n')
  assert.match(out[0], /\[#1\]/)
  assert.deepEqual(out.slice(1, 7), ['```bash', 'echo #2', '```', '~~~', '#3', '~~~'])
  assert.match(out[7], /\[#4\]/)
  // an unclosed fence (a reply still streaming) keeps the rest as code
  assert.equal(md('```\n#1'), '```\n#1')
})

test('glyph and ansi formats', () => {
  assert.equal(md('#1'), '[#1](https://github.com/giocaizzi/harness/issues/1)')
  assert.equal(linkify('#1', GH, { glyph: true }), `[${KIND.issue.icon} #1](https://github.com/giocaizzi/harness/issues/1)`)
  assert.equal(linkify('!2', GL, { glyph: true }), `[${KIND.pr.icon} !2](https://gitlab.com/group/sub/proj/-/merge_requests/2)`)
  assert.equal(linkify('AB#3', AZ, { glyph: true }), `[${KIND.workitem.icon} AB#3](https://dev.azure.com/acme/Web%20App/_workitems/edit/3)`)
  const url = 'https://github.com/giocaizzi/harness/issues/1'
  assert.equal(linkify('#1', GH, { format: 'ansi' }), `\x1b]8;;${url}\x1b\\#1\x1b]8;;\x1b\\`)
  assert.equal(linkify('#1', GH, { format: 'ansi', glyph: true, color: true }), `\x1b]8;;${url}\x1b\\\x1b[38;2;166;227;161m${KIND.issue.icon} #1\x1b[39m\x1b]8;;\x1b\\`)
})

test('no remote, no forge or no text: unchanged', () => {
  assert.equal(linkify('#1', null), '#1')
  assert.equal(linkify('#1', 'https://bitbucket.org/o/r'), '#1')
  assert.equal(linkify('', GH), '')
})

test('styled follows NO_COLOR', () => {
  assert.equal(styled({}), true)
  assert.equal(styled({ NO_COLOR: '1' }), false)
  assert.equal(styled({ NO_COLOR: '' }), true)
})
