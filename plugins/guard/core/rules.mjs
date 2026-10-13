// Rule data for the shared engine. Plain module (not JSON) so a Claude Code mod can import it.
export const rules = {
  "skills": [
    {
      "id": "commit",
      "match": "\\bgit\\s+commit\\b",
      "skills": [
        "conventional-commits",
        "ship"
      ],
      "why": "commit messages must be Conventional Commits"
    },
    {
      "id": "pr",
      "match": "\\bgh\\s+(pr\\s+(create|merge|ready)|stack)\\b|\\bglab\\s+mr\\s+(create|merge)\\b|\\baz\\s+repos\\s+pr\\s+(create|update)\\b",
      "skills": [
        "github-workflow",
        "repo-standard",
        "ship",
        "land"
      ],
      "why": "PRs land through auto-merge or the merge queue"
    },
    {
      "id": "ruleset",
      "match": "\\bgh\\s+api\\b.*\\b(rulesets|protection)\\b",
      "skills": [
        "github-workflow"
      ],
      "why": "rulesets and branch protection have a house policy"
    },
    {
      "id": "worktree",
      "match": "\\bgit\\s+worktree\\s+add\\b",
      "skills": [
        "wt",
        "host-hygiene"
      ],
      "why": "worktrees are one per task and removed on merge"
    },
    {
      "id": "release",
      "match": "\\b(release-please|npm\\s+version|git\\s+tag)\\b",
      "skills": [
        "release-please",
        "semver"
      ],
      "why": "versions and tags are owned by release automation"
    },
    {
      "id": "secrets",
      "match": "\\bbws?\\s+(secret|run|get|list|unlock|login)\\b",
      "skills": [
        "secrets-handling"
      ],
      "why": "secrets are never printed or inlined"
    }
  ],
  "deny": [
    {
      "id": "pip",
      "when": "uv",
      "match": "(?<!uv )(?<![\\w-])(pipx|pip3?|python3? -m pip)(\\s|$)",
      "why": "This repo uses uv: use uv add / uv run / uvx, not pip or pipx."
    },
    {
      "id": "poetry",
      "when": "uv",
      "match": "(?<![\\w./-])poetry(\\s|$)",
      "why": "This repo uses uv: use uv add / uv sync / uv run, not poetry."
    }
  ],
  "heavy": [
    {
      "id": "build",
      "match": "\\b(eas\\s+build|xcodebuild|gradlew?\\s+(assemble|build)|docker\\s+build|npm\\s+run\\s+build|cargo\\s+build|maestro\\s+test)\\b"
    },
    {
      "id": "tests",
      "match": "\\b(pytest|vitest|jest|npm\\s+(run\\s+)?test|make\\s+(test|check))\\b"
    }
  ],
  // `prefixes`: the plain forms the harness itself asks for where a hook cannot (Codex prompt rules, opencode
  // `permission.bash` ask). A risky command outside them is denied there.
  "risky": [
    {
      "id": "rm",
      "match": "\\brm\\s+(?:-[\\w-]+\\s+)*(?:-[a-z]*r[a-z]*|--recursive)\\b|\\bremove-item\\b.*-recurse",
      "why": "recursive delete",
      "prefixes": [["rm", "-r"], ["rm", "-R"], ["rm", "-rf"], ["rm", "-fr"], ["rm", "-Rf"], ["rm", "-fR"], ["rm", "--recursive"]]
    },
    {
      "id": "worktree-rm",
      "match": "\\bgit\\s+worktree\\s+remove\\b.*(--force|\\s-f\\b)",
      "why": "discards uncommitted work in a worktree",
      "prefixes": [["git", "worktree", "remove", "--force"], ["git", "worktree", "remove", "-f"]]
    },
    {
      "id": "reset",
      "match": "\\bgit\\s+reset\\s+--hard\\b",
      "why": "discards local work",
      "prefixes": [["git", "reset", "--hard"]]
    },
    {
      "id": "force",
      "match": "\\bgit\\s+push\\b.*(--force|\\s-f\\b)",
      "why": "rewrites remote history",
      "prefixes": [["git", "push", "--force"], ["git", "push", "-f"], ["git", "push", "--force-with-lease"]]
    },
    {
      "id": "terraform",
      "match": "\\bterraform\\s+(apply|destroy)\\b",
      "why": "changes real infrastructure",
      "prefixes": [["terraform", "apply"], ["terraform", "destroy"]]
    },
    {
      "id": "merge",
      "match": "\\bgh\\s+pr\\s+merge\\b.*--admin|\\baz\\s+repos\\s+pr\\s+(create|update)\\b.*--bypass-policy\\b(?![\\s=]+false)",
      "why": "bypasses merge rules"
    }
  ],
  "titles": {
    "types": ["feat", "fix", "perf", "refactor", "revert", "docs", "style", "test", "build", "ci", "chore"],
    "why": "squash merge makes the PR title the commit on main, and release automation reads it"
  },
  "host": {
    "loadCap": 30,
    "cpuPercentCap": 90,
    "freeFloorGb": 20,
    "wrapper": "\\b(heavy|lease)\\.(sh|ps1)\\b"
  },
  "usage": {
    "warnPercent": 70,
    "throttlePercent": 90
  }
}
