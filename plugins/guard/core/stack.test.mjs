// The stacked-PR hint: which `gh pr create|merge` units the engine reads, the facts it gathers through an injected
// runner, and the once-per-agent hint evaluateCommand returns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCommand, stackFacts, stackTargets } from './engine.mjs'
import { rules } from './rules.mjs'

const env = { HOME: '/Users/me', dirs: { has: () => true } }

test('stackTargets reads create and merge units: base, operand, repo, cd', () => {
  const t = (c) => stackTargets(c, rules, env)
  assert.deepEqual(t('gh pr create --fill'), [{ verb: 'create', dir: '', base: null, pr: null, repo: null, head: null }])
  assert.equal(t('gh pr create --base feat/a --title "x y" --fill')[0].base, 'feat/a')
  assert.equal(t('gh pr create --base=feat/a --fill')[0].base, 'feat/a')
  assert.equal(t('gh pr create --title main --fill')[0].base, null)
  const m = t('gh pr merge 12 --auto --squash -R acme/app')[0]
  assert.deepEqual([m.verb, m.pr, m.repo, m.base], ['merge', '12', 'acme/app', null])
  assert.equal(t('cd /work/app && gh pr create --fill')[0].dir, '/work/app')
  assert.deepEqual(t('gh pr view 12'), [])
  assert.deepEqual(t('echo gh pr create'), [])
})

// A repo where `feat/b` (HEAD) is built on `feat/a` (#7), which is not in main; `feat/old` (#5) is merged into main.
const fake = ({ def = 'origin/main\n', onTop = ['feat/a', 'feat/old'], inDefault = ['feat/old'], open = [{ number: 7, headRefName: 'feat/a' }, { number: 5, headRefName: 'feat/old' }, { number: 9, headRefName: 'feat/b' }], pr = { headRefName: 'feat/b', baseRefName: 'main' }, fail = null } = {}) => {
  const calls = []
  const run = async (argv) => {
    const a = argv.join(' ')
    calls.push(a)
    if (fail && a.includes(fail)) return null
    if (argv[1] === 'symbolic-ref') return def
    if (argv[1] === 'rev-parse') return 'feat/b\n'
    if (argv[0] === 'gh' && argv[1] === 'repo') return 'main\n'
    if (argv[0] === 'gh' && argv[2] === 'view') return JSON.stringify(pr)
    if (argv[0] === 'gh' && argv[2] === 'list') return JSON.stringify(open)
    if (argv[1] === 'merge-base') {
      const other = argv[3].replace('origin/', '')
      return (argv[4] === 'origin/main' ? inDefault : onTop).includes(other) ? '' : null
    }
    throw new Error(`unexpected ${a}`)
  }
  return { run, calls }
}

test('stackTargets parses value flags per verb, attached values included', () => {
  const t = (c) => stackTargets(c, rules, env)[0]
  assert.equal(t('gh pr merge -m 12').pr, '12')
  assert.equal(t('gh pr merge -r 12').pr, '12')
  assert.equal(t('gh pr merge -s -d 12').pr, '12')
  assert.equal(t('gh pr merge -t subj 12').pr, '12')
  assert.equal(t('gh pr merge --match-head-commit abc 12').pr, '12')
  assert.equal(t('gh pr create -Racme/app --fill').repo, 'acme/app')
  assert.equal(t('gh pr create -Bfeat/a --fill').base, 'feat/a')
  assert.equal(t('gh pr create -m ms -T tpl -p proj --fill').base, null)
  assert.equal(t('gh pr create --head feat/x --fill').head, 'feat/x')
  assert.equal(t('gh pr create -H feat/x --fill').head, 'feat/x')
})

test('stackFacts: a repo starting with a dash, or a create with --head, gives {} without a lookup', async () => {
  const { run, calls } = fake()
  assert.deepEqual(await stackFacts('gh pr create -R -wb/x --fill', rules, run, env), {})
  assert.deepEqual(await stackFacts('gh pr create --head feat/x --fill', rules, run, env), {})
  assert.deepEqual(await stackFacts('gh pr create -H feat/x --fill', rules, run, env), {})
  assert.deepEqual(calls, [])
})

test('stackFacts: a create that builds on an open PR not in the default branch gives the PR below', async () => {
  const { run, calls } = fake()
  assert.deepEqual(await stackFacts('gh pr create --fill', rules, run, env), { below: { number: 7, branch: 'feat/a' }, base: 'main' })
  assert.ok(calls.includes('git merge-base --is-ancestor origin/feat/a HEAD'))
  assert.ok(!calls.some((c) => c.includes('origin/feat/b ')), 'the head itself is skipped')
})

test('stackFacts: a merge reads head and base from the PR and tests origin/<head>', async () => {
  const { run, calls } = fake()
  assert.equal((await stackFacts('gh pr merge 9 --squash', rules, run, env)).below.number, 7)
  assert.ok(calls.includes('git merge-base --is-ancestor origin/feat/a origin/feat/b'))
  assert.ok(calls.some((c) => c.startsWith('gh pr view 9 --json headRefName,baseRefName')))
})

test('stackFacts: falls back to gh for the default branch', async () => {
  const { run } = fake({ fail: 'symbolic-ref' })
  assert.equal((await stackFacts('gh pr create --fill', rules, run, env)).base, 'main')
})

test('stackFacts: already stacked, another base, or nothing below gives {}', async () => {
  assert.deepEqual(await stackFacts('gh pr create --base feat/a --fill', rules, fake().run, env), {})
  assert.deepEqual(await stackFacts('gh pr merge 9', rules, fake({ pr: { headRefName: 'feat/b', baseRefName: 'feat/a' } }).run, env), {})
  assert.deepEqual(await stackFacts('gh pr create --fill', rules, fake({ inDefault: ['feat/old', 'feat/a'] }).run, env), {})
  assert.deepEqual(await stackFacts('gh pr create --fill', rules, fake({ onTop: [] }).run, env), {})
})

test('stackFacts: failures and odd names give {}', async () => {
  for (const fail of ['rev-parse', 'pr list', 'gh repo']) {
    assert.deepEqual(await stackFacts('gh pr create --fill', rules, fake({ fail, def: null }).run, env), {}, fail)
  }
  assert.deepEqual(await stackFacts('gh pr create --fill', rules, async () => { throw new Error('boom') }, env), {})
  assert.deepEqual(await stackFacts('gh pr create --fill', rules, fake({ open: [{ number: 7, headRefName: 'a;rm -rf x' }] }).run, env), {})
  assert.deepEqual(await stackFacts('gh pr create --base "$B" --fill', rules, fake().run, env), {})
  assert.deepEqual(await stackFacts('gh pr list', rules, fake().run, env), {})
})

const below = { below: { number: 7, branch: 'feat/a' }, base: 'main' }
const skills = ['pr', 'ship', 'github-workflow', 'conventional-commits']
const decide = (command, state, stack = below, loaded = skills) => evaluateCommand({ command, state, env, stack, loadedSkills: new Set(loaded), rules })

test('evaluateCommand: the hint names the PR and the default branch, once', () => {
  const state = { reminded: new Set() }
  const d = decide('gh pr create --fill', state)
  assert.deepEqual([d.action, d.rule, d.remind], ['allow', 'stack', true])
  assert.match(d.context, /#7 \(`feat\/a`\).*targets `main`/)
  assert.match(d.context, /gh stack init.*Stacks without `gh stack`/)
  assert.ok(state.reminded.has('stack'))
  assert.deepEqual(decide('gh pr create --fill', state), { action: 'allow' })
  assert.deepEqual(decide('gh pr create --fill', { reminded: new Set() }, {}), { action: 'allow' })
})

test('evaluateCommand: a deny, an ask or a skill deny wins over the hint', () => {
  const state = { reminded: new Set() }
  assert.equal(decide('gh pr create --title "bad title"', state).rule, 'title')
  assert.equal(decide('gh pr merge 9 && rm -rf src', state).action, 'ask')
  const skill = decide('gh pr create --fill', state, below, [])
  assert.equal(skill.action, 'deny')
  assert.ok(!state.reminded.has('stack'))
})
