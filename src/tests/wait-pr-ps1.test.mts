// Tests for plugins/dev-tools/skills/land/scripts/wait-pr.ps1, concurrently. Windows only, like the script
// (CI's windows-scripts job runs this file); elsewhere, or without pwsh, the suite is skipped, which that job fails.
import { describe } from "node:test";
import { spawnSync } from "node:child_process";
import { CONCURRENCY, commonTests, win } from "./wait-pr-lib.mjs";

const pwsh =
  win && spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
void describe(
  "wait-pr.ps1",
  { concurrency: CONCURRENCY, skip: !pwsh && "Windows with pwsh only" },
  () => {
    commonTests("ps1");
  },
);
