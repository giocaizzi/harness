// Plays one of the plugin's clips with afplay, detached so a hook process need not wait for it. macOS only, as in
// Claude Code: Linux and Windows have no player the plugin can count on.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOUNDS = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds')

export function afplay(name) {
  if (process.platform !== 'darwin') return
  const child = spawn('afplay', [join(SOUNDS, `${name}.wav`)], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}
