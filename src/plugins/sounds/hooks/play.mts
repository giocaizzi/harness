// Plays plugin clips without making hook completion wait for the player. macOS is the only supported player host.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const soundsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "sounds",
);

/** Start a clip asynchronously when macOS provides afplay. */
export function afplay(name: string): void {
  if (process.platform !== "darwin") return;
  const child = spawn("afplay", [join(soundsDirectory, `${name}.wav`)], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // A missing player must never make a hook fail.
  });
  child.unref();
}

/** Ring the active terminal, if this process still has one. */
export function bell(): void {
  try {
    writeFileSync(
      process.platform === "win32" ? "CONOUT$" : "/dev/tty",
      "\x07",
    );
  } catch {
    // Detached hooks and CI have no terminal.
  }
}
