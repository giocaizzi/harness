// Plays one of the plugin's clips with afplay, detached so a hook process need not wait for it. macOS only, as in
// Claude Code: Linux and Windows have no player the plugin can count on. `bell` rings the terminal bell, so the
// terminal can mark the tab (Ghostty: 🔔 in the title, a border, a Dock bounce), as Claude Code's `terminal_bell`
// channel, Codex's `notification_method = "bel"` and Copilot's `beep` do natively.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOUNDS = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds')

export function afplay(name) {
  if (process.platform !== 'darwin') return
  const child = spawn('afplay', [join(SOUNDS, `${name}.wav`)], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

export function bell() {
  try {
    writeFileSync(process.platform === 'win32' ? 'CONOUT$' : '/dev/tty', '\x07')
  } catch {} // no terminal (CI, a detached server): nothing to ring
}
