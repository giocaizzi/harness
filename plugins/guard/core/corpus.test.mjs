// Regression corpus: real commands (paraphrased, hosts and paths anonymised) from the guard reviews, each with the
// decision the guard must reach. Rows of an open bug run as `todo`, so the suite stays green while the fix is pending;
// the PR that fixes a bug drops its id from OPEN. Every new false ask or missed command found in telemetry or
// transcripts becomes a row here.
// Row: [command, expected ('allow' | 'allow:<hint>' | 'ask:<rule>' | 'deny:<rule>'), bug id, source, options?]
// options: { python: 'uv' } the repo's Python manager; { hints: true } the read and edit hints not yet shown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { branchFacts, evaluateCommand, regenFacts, worktreeFacts } from './engine.mjs'
import { rules } from './rules.mjs'

const OPEN = new Set(['G10', 'G11', 'G12', 'G13', 'G14'])

const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'))
const env = { TMPDIR: '/var/folders/ab/xyz/T/', HOME: '/Users/me' }
const loadedSkills = new Set(['conventional-commits', 'github-workflow', 'wt', 'release-please', 'docs-sync', 'python-testing', 'pr-fix'])

// Facts the guard gathers come back favourable, so a row asks only when the guard cannot reach or read them:
// every branch is pushed, every regenerable name is git-ignored, no target is a linked worktree.
const run = async (argv) => {
  if (argv.includes('rev-list')) return '0\n'
  if (argv.includes('check-ignore')) return ''
  if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return '/Users/me/repo\n'
  return null
}

const decide = async (command, { python = null, hints = false } = {}) => {
  const [worktrees, branches, regenerable] = await Promise.all([worktreeFacts(command, env, rules, run), branchFacts(command, rules, run, env), regenFacts(command, env, rules, run)])
  const state = { reminded: new Set(hints ? [] : ['read', 'edit']) }
  const d = evaluateCommand({ command, loadedSkills, state, env, worktrees, branches, regenerable, python, rules })
  return d.action + (d.rule && !(d.action === 'allow' && !d.remind) ? `:${d.rule}` : '')
}

for (const [command, expected, bug, source, options] of corpus) {
  test(`${bug} ${JSON.stringify(command)} -> ${expected} (${source})`, { todo: OPEN.has(bug) && !/^(control|probe)/.test(source) }, async () => {
    assert.equal(await decide(command, options), expected)
  })
}

test('every row names a known bug or a control, and no command repeats', () => {
  const seen = new Set()
  for (const [command, expected, bug] of corpus) {
    assert.match(bug, /^(G\d\d|D\d+|CTRL)$/, command)
    assert.match(expected, /^(allow|ask|deny)(:[\w-]+)?$/, command)
    assert.ok(!seen.has(command), `duplicate row: ${command}`)
    seen.add(command)
  }
})
