// Tests for plugins/dev-tools/skills/land/scripts/wait-pr.ps1, concurrently. Windows only, like the script
// (CI's windows-scripts job runs this file); elsewhere, and without pwsh, nothing runs.
import { describe } from 'node:test'
import { spawnSync } from 'node:child_process'
import { CONCURRENCY, commonTests, win } from './wait-pr-lib.mjs'

if (win && spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0) {
  describe('wait-pr.ps1', { concurrency: CONCURRENCY }, () => commonTests('ps1'))
}
