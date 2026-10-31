// Scratch git repos for the factory tests that read a config from the default branch: a bare origin and a clone,
// with git cut off from the caller's environment (no inherited GIT_DIR or GIT_WORK_TREE, no global or system config).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The caller's environment without any GIT_* variable or FACTORY_* variable, plus an isolated config and identity.
export const gitEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('FACTORY_'))),
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  ...extra,
})

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// A bare origin whose default branch `main` commits `committed` as .factory/config.yaml (no file when null), and a
// clone `work` of it. `git(...)` runs in the clone; `put(text)` commits a config there on the current branch.
export const originRepo = (committed) => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-origin-'))
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '-q', origin, work)
  git(work, 'checkout', '-q', '-b', 'main')
  const put = (text, msg = 'config') => {
    mkdirSync(join(work, '.factory'), { recursive: true })
    writeFileSync(join(work, '.factory', 'config.yaml'), text)
    git(work, 'add', '.factory/config.yaml')
    git(work, 'commit', '-q', '-m', msg)
  }
  if (committed === null) git(work, 'commit', '-q', '--allow-empty', '-m', 'init')
  else put(committed)
  git(work, 'push', '-q', 'origin', 'main')
  return { dir, origin, work, git: (...a) => git(work, ...a), put, done: () => rmSync(dir, { recursive: true, force: true }) }
}
