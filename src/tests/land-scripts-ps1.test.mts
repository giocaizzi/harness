// Tests for plugins/dev-tools/skills/land/scripts/{land-many,resync-after-squash,verify-merge-only}.ps1. Windows only, like the scripts
// (CI's windows-scripts job runs this file); elsewhere, or without pwsh, the suite is skipped, which that job fails.
import { describe } from "node:test";
import { spawnSync } from "node:child_process";
import {
  CONCURRENCY,
  landManyTests,
  resyncTests,
  verifyMergeTests,
  win,
} from "./land-scripts-lib.mjs";

const pwsh =
  win && spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
void describe(
  "land scripts (ps1)",
  { concurrency: CONCURRENCY, skip: !pwsh && "Windows with pwsh only" },
  () => {
    landManyTests("ps1");
    resyncTests("ps1");
    verifyMergeTests("ps1");
  },
);
