// Tests for plugins/dev-tools/skills/land/scripts/{land-many,resync-after-squash,verify-merge-only}.sh (macOS/Linux; Windows runs the .ps1).
import { describe } from "node:test";
import {
  CONCURRENCY,
  landManyTests,
  resyncTests,
  verifyMergeTests,
  win,
} from "./land-scripts-lib.mjs";

if (!win) {
  void describe("land scripts (sh)", { concurrency: CONCURRENCY }, () => {
    landManyTests("sh");
    resyncTests("sh");
    verifyMergeTests("sh");
  });
}
