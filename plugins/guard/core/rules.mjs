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
      // Writes only: an explicit write method, or body fields (gh api then defaults to POST).
      "match": "\\bgh\\s+api\\b(?=.*\\b(rulesets|protection)\\b)(?=.*(\\s(-X|--method)[\\s=]*(POST|PUT|PATCH|DELETE)\\b|\\s(-f|-F|--field|--raw-field|--input)\\b))",
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
      // What cuts a release, not what reads one: release-please-config.json, a release-please workflow or
      // `git tag -l` pass. Bare `git tag` lists, so a tag name or a creating flag must follow.
      "match": "\\brelease-please\\s+(release-pr|github-release|bootstrap)\\b|\\bnpm\\s+version\\b|\\bgit\\s+tag\\s+(?!(-l|--list|-n\\d*|--contains|--no-contains|--points-at|--merged|--no-merged|-v|--verify|--sort|--format|--column|-i|--ignore-case)\\b)[^\\s;&|]",
      "skills": [
        "release-please",
        "semver"
      ],
      "why": "versions and tags are owned by release automation"
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
      // `--force-with-lease` to a feature branch passes: it cannot clobber work it has not seen, and a branch
      // ruleset rejects it on a protected default branch. ponytail: a bare lease push from main is not caught.
      "match": "\\bgit\\s+push\\b[^;&|\\n]*(--force(?!-with-lease)\\b|\\s-[a-z]*f[a-z]*\\b|\\s\\+[^\\s;&|]|--force-with-lease\\b[^;&|\\n]*\\b(main|master)\\b)",
      "why": "rewrites remote history",
      "prefixes": [["git", "push", "--force"], ["git", "push", "-f"]]
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
    },
    // Matched on what runs, so a token injected through a quoted `VAR="$(keyring read)" ./script` passes:
    // the value goes to one process's environment, never to output. Known gap: `echo "$(bws secret get x)"` passes too.
    {
      "id": "secrets",
      "match": "\\bbws?\\s+(secret|get|list|run|unlock|login|export|serve)\\b|\\bsecurity\\s+find-(generic|internet)-password\\b[^|;&\\n]*\\s-[a-z]*[wg][a-z]*\\b|\\bchezmoi\\s+secret\\s+keyring\\s+get\\b|\\bop\\s+read\\b|\\bop\\s+item\\s+get\\b[^|;&\\n]*\\s--reveal\\b|\\bpass\\s+show\\b|\\bgcloud\\s+secrets\\s+versions\\s+access\\b|\\baz\\s+keyvault\\s+secret\\s+show\\b|(^|[;&|(\\n]\\s*)printenv\\s+\\w*(token|secret|key|pass|credential)|\\b(cat|less|more|head|tail|bat)\\s+([^\\s;&|]+\\s+)*([^\\s;&|]*/)?\\.env(\\.(?!example\\b|sample\\b|template\\b|dist\\b)[\\w.-]+)?(?=[\\s;&|)]|$)",
      "why": "reads a secret; load `secrets-handling` and never print or inline the value",
      "prefixes": [
        ["bw", "get"], ["bw", "list"], ["bw", "unlock"], ["bw", "login"], ["bw", "export"], ["bw", "serve"],
        ["bws", "secret"], ["bws", "get"], ["bws", "list"], ["bws", "run"],
        ["chezmoi", "secret", "keyring", "get"], ["op", "read"], ["pass", "show"],
        ["gcloud", "secrets", "versions", "access"], ["az", "keyvault", "secret", "show"],
        ["cat", ".env"], ["less", ".env"]
      ]
    },
    // `raw` must also match the command as written: the grep pattern is usually quoted, which `match` cannot see.
    {
      "id": "secrets-env",
      "match": "(^|[;&|(\\n]\\s*)(printenv|env)\\b(?![-.=])[^;&\\n]*\\|\\s*(e?grep|rg|findstr|select-string)\\b",
      "raw": "token|secret|key|pass|credential",
      "why": "dumps secret environment variables; load `secrets-handling` and filter to names only"
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
