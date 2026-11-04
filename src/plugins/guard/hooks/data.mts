// Where the guard keeps its files: the harness's plugin data dir (Claude Code, Copilot CLI), else a per-user dir
// under the temp dir (VS Code, opencode, pi), so another user's files are never read; created private (0700).

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const fallbackDataDir = (): string => {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  return join(tmpdir(), `guard-plugin-${String(uid ?? userInfo().username)}`);
};

export const pluginDataDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CLAUDE_PLUGIN_DATA ?? env.COPILOT_PLUGIN_DATA ?? fallbackDataDir();

// The data dir is writable by the agent, so a hook reads and appends to its files only through these two: opened
// non-blocking and without following a link, checked through the descriptor, so a FIFO, a device or a symlink planted
// at the path is refused and never hangs the hook (a hook that times out lets the tool call or the stop through).
const flag = (name: "O_NONBLOCK" | "O_NOFOLLOW"): number =>
  (constants as Partial<Record<string, number>>)[name] ?? 0; // absent on Windows

export interface ReadOptions {
  // also refuse a file with another hard link
  singleLink?: boolean;
}

// The text of a regular file of at most `maxBytes`. Throws on anything else: the open error as is (ENOENT, ELOOP, ...)
// or an error with code ENOTREG (not a regular file) or EFBIG (too large), so a caller can tell "missing" from "refused".
export function readDataFileStrict(
  file: string,
  maxBytes: number,
  opts: ReadOptions = {},
): string {
  const fd = openSync(
    file,
    constants.O_RDONLY | flag("O_NONBLOCK") | flag("O_NOFOLLOW"),
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (opts.singleLink === true && st.nlink > 1)) {
      throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
    }
    if (st.size > maxBytes) {
      throw Object.assign(new Error("too large"), { code: "EFBIG" });
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

// The same, or null on anything that is not such a file.
export function readDataFile(
  file: string,
  maxBytes: number,
  opts: ReadOptions = {},
): string | null {
  try {
    return readDataFileStrict(file, maxBytes, opts);
  } catch {
    return null;
  }
}

// Appends to a regular file (created 0600), opened non-blocking and without following a link: a FIFO or a symlink at
// the path throws (ENXIO, ELOOP, ENOTREG) instead of blocking or writing through.
export function appendDataFile(file: string, text: string): void {
  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      flag("O_NONBLOCK") |
      flag("O_NOFOLLOW"),
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
    }
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
