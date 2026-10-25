// Tests for plugins/dev-tools/skills/land/scripts/wait-pr.sh (macOS/Linux; Windows runs wait-pr.ps1), concurrently.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { CONCURRENCY, commonTests, pids, setup, survivors, win } from './wait-pr-lib.mjs'

if (!win) {
  describe('wait-pr.sh', { concurrency: CONCURRENCY }, () => {
    commonTests('sh')

    // A signal reaches the .sh between polls or while it waits on gh; Windows has no SIGTERM.
    test('sh: SIGTERM ends the wait and the running gh call with it', async () => {
      const { file, exe, argv, env } = setup('sh', [{ view: 'stubborn' }], ['--interval', '1', '--timeout', '60'], { SHIM_NOEXEC: '1' })
      const child = spawn(exe, argv, { env, stdio: 'ignore' })
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal)))
      for (let i = 0; i < 100 && pids(file).length < 1; i++) await new Promise((r) => setTimeout(r, 100))
      assert.ok(pids(file).length > 0, 'gh never started')
      child.kill('SIGTERM')
      assert.equal(await exited, 143)
      assert.deepEqual(await survivors(file), [])
    })
  })
}
