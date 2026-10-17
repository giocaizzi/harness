// Rule data for the shared engine. Plain module (not JSON) so a Claude Code mod can import it.
export const rules = {
  "skills": [
    {
      "id": "commit",
      "match": "\\bgit\\s+commit(?![\\w-])",
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
    },
    // `remind`: a once-per-session hint instead of a deny, for skills the agent rarely loads on its own.
    {
      "id": "pr-fix",
      "remind": true,
      "match": "\\bgh\\s+pr\\s+view\\b.*--comments\\b|\\bgh\\s+api\\b.*\\bpulls/\\d+/(comments|reviews)\\b|\\bgh\\s+run\\s+view\\b.*--log-failed\\b|\\bglab\\s+mr\\s+(view|note)\\b.*--comments\\b",
      "skills": [
        "pr-fix",
        "land"
      ],
      "why": "review comments and failing CI are fixed in one pass, then pushed"
    },
    {
      "id": "pytest",
      "remind": true,
      "match": "\\bpytest\\b",
      "skills": [
        "python-testing"
      ],
      "why": "tests follow the house pytest conventions"
    }
  ],
  // Edits whose path matches: a once-per-session hint toward the skill.
  "files": [
    {
      "id": "docs",
      "match": "(^|/)(docs/.+\\.md|README\\.md|AGENTS\\.md)$",
      "skills": [
        "docs-sync"
      ],
      "why": "docs, runbooks, README and AGENTS.md follow the change in the same PR"
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
  // `permission.bash` ask). A risky command outside them is denied there. Rules match with git's global options
  // removed (`git -C dir reset` is `git reset`) and ignore case unless `case` is set.
  "risky": [
    {
      "id": "rm",
      // Not `git rm`: its files are in git (`git-rm` below asks when it would drop their changes). PowerShell's
      // `-Recurse` may be abbreviated to `-r`; cmd's `rd /s` and `del /s` recurse too.
      "match": "(?<!\\bgit\\s+)\\brm\\s+(?:-[\\w-]+\\s+)*(?:-[a-z]*r[a-z]*|--recursive)\\b|\\bremove-item\\b[^;|\\n]*\\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\\b|(?:^|[;&|({\\n])\\s*(?:ri|del|erase|rd|rmdir)\\s(?:[^;|\\n]*\\s)?(?:-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\\b|/s\\b)",
      "why": "recursive delete",
      "prefixes": [["rm", "-r"], ["rm", "-R"], ["rm", "-rf"], ["rm", "-fr"], ["rm", "-Rf"], ["rm", "-fR"], ["rm", "--recursive"]]
    },
    {
      // No prefixes: a prompt rule matches from the first word, and `find PATH` would ask for every find.
      "id": "find",
      "match": "\\bfind\\b[^;&|\\n]*\\s(?:-delete\\b|-exec(?:dir)?\\s+(?:\\S*/)?rm\\b)",
      "why": "find deletes everything it matches, through the whole tree"
    },
    {
      "id": "worktree-rm",
      "match": "\\bgit\\s+worktree\\s+remove\\b[^;&|\\n]*(--force|\\s-f\\b)",
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
      "id": "clean",
      "match": "\\bgit\\s+clean\\b(?![^;&|\\n]*\\s(?:-[a-z]*n[a-z]*|--dry-run)\\b)(?=[^;&|\\n]*\\s(?:-[a-z]*f[a-z]*|--force)\\b)",
      "why": "deletes untracked files, which git cannot restore",
      "prefixes": [["git", "clean", "-f"], ["git", "clean", "-fd"], ["git", "clean", "-df"], ["git", "clean", "-fdx"], ["git", "clean", "-dfx"], ["git", "clean", "-xdf"], ["git", "clean", "-fx"], ["git", "clean", "-xf"], ["git", "clean", "-ffdx"], ["git", "clean", "--force"]]
    },
    {
      // A whole-tree or directory pathspec (`.`, `:/`, `dir/`, a glob), or a forced checkout or switch. One named
      // file (`git checkout -- f`, `git restore f`) passes: a narrow, deliberate revert. `restore --staged` only unstages.
      "id": "discard",
      "match": "\\bgit\\s+checkout\\b[^;&|\\n]*\\s(?:-f|--force|\\.{1,2}/?|:/?|:\\([^)\\s]*\\)\\S*|[^\\s;&|]*[*?][^\\s;&|]*|[^\\s;&|]+/)(?=[\\s;&|)]|$)|\\bgit\\s+switch\\b[^;&|\\n]*\\s(?:-f|--force|--discard-changes)\\b|\\bgit\\s+restore\\b(?=[^;&|\\n]*\\s(?:--worktree|-W)\\b|(?![^;&|\\n]*\\s(?:--staged|-S)\\b))[^;&|\\n]*\\s(?:\\.{1,2}/?|:/?|:\\([^)\\s]*\\)\\S*|[^\\s;&|]*[*?][^\\s;&|]*|[^\\s;&|]+/)(?=[\\s;&|)]|$)",
      "why": "discards uncommitted changes, which git cannot restore",
      "prefixes": [["git", "checkout", "."], ["git", "checkout", "--", "."], ["git", "checkout", "-f"], ["git", "checkout", "--force"], ["git", "restore", "."], ["git", "switch", "-f"], ["git", "switch", "--force"], ["git", "switch", "--discard-changes"]]
    },
    {
      "id": "stash",
      "match": "\\bgit\\s+stash\\s+(?:drop|clear)\\b",
      "why": "discards stashed work; only git fsck can find it again",
      "prefixes": [["git", "stash", "drop"], ["git", "stash", "clear"]]
    },
    {
      // Case-sensitive: `-d` refuses an unmerged branch, `-D` (or `-d` with `-f`) deletes it anyway. A branch whose
      // commits are all on a remote ref or in a merged PR passes (branch facts).
      "id": "branch-delete",
      "case": true,
      "match": "\\bgit\\s+branch\\b(?:[^;&|\\n]*\\s(?:-[a-zA-Z]*D[a-zA-Z]*|-[a-z]*(?:df|fd)[a-z]*)\\b|(?=[^;&|\\n]*\\s(?:--delete|-d)\\b)(?=[^;&|\\n]*\\s(?:--force|-f)\\b))",
      "why": "deletes a branch git has not seen merged",
      "prefixes": [["git", "branch", "-D"]]
    },
    {
      "id": "force",
      // `--force-with-lease` to a feature branch passes: it cannot clobber work it has not seen, and a branch
      // ruleset rejects it on a protected default branch. ponytail: a bare lease push from main is not caught.
      "match": "\\bgit\\s+push\\b[^;&|\\n]*(--force(?!-with-lease)\\b|\\s-[a-z]*f[a-z]*\\b|\\s\\+[^\\s;&|]|--force-with-lease\\b[^;&|\\n]*[\\s:](?:refs/heads/)?(main|master)(?=[\\s;&|)]|$))",
      "why": "rewrites remote history",
      "prefixes": [["git", "push", "--force"], ["git", "push", "-f"]]
    },
    {
      // Deleting a feature branch on the remote passes; main and master do not.
      "id": "push-delete",
      "match": "\\bgit\\s+push\\b[^;&|\\n]*\\s(?:--mirror|--prune)\\b|\\bgit\\s+push\\b(?=[^;&|\\n]*\\s(?:--delete|-d)\\b)[^;&|\\n]*\\s(?:refs/heads/)?(?:main|master)(?=[\\s;&|)]|$)|\\bgit\\s+push\\b[^;&|\\n]*\\s:(?:refs/heads/)?(?:main|master)(?=[\\s;&|)]|$)",
      "why": "deletes remote branches",
      "prefixes": [["git", "push", "--mirror"], ["git", "push", "--prune"]]
    },
    {
      "id": "git-rm",
      "match": "\\bgit\\s+rm\\b(?![^;&|\\n]*\\s--cached\\b)(?=[^;&|\\n]*\\s(?:-[a-z]*f[a-z]*|--force)\\b)",
      "why": "drops uncommitted changes to the removed files",
      "prefixes": [["git", "rm", "-f"], ["git", "rm", "-rf"], ["git", "rm", "-fr"], ["git", "rm", "--force"]]
    },
    {
      "id": "terraform",
      "match": "\\bterraform\\s+(apply|destroy)\\b",
      "why": "changes real infrastructure",
      "prefixes": [["terraform", "apply"], ["terraform", "destroy"]]
    },
    {
      "id": "merge",
      "match": "\\bgh\\s+pr\\s+merge\\b[^;&|\\n]*--admin|\\baz\\s+repos\\s+pr\\s+(create|update)\\b[^;&|\\n]*--bypass-policy\\b(?![\\s=]+false)",
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
