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
    },
    {
      "id": "go-test",
      "remind": true,
      "match": "\\bgo\\s+test\\b",
      "skills": [
        "go-testing"
      ],
      "why": "tests follow the house Go test conventions"
    },
    {
      "id": "go-lint",
      "remind": true,
      "match": "\\bgo\\s+(vet|build)\\b|\\bgolangci-lint\\b",
      "skills": [
        "go-development"
      ],
      "why": "build and lint follow the house Go conventions"
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
  // A once-per-agent hint toward the harness's LSP tool when a search looks for a symbol, not text. `programs` are the
  // shell searchers (`git grep` is `git` + `grep`); a search matches on a `declaration` pattern (`def name`, `class\s+Name`),
  // or on an `identifier` (camelCase, snake_case, PascalCase) or a whole-word name together with a language filter
  // (`ext` as a glob or path suffix, `types` as rg's `-t`). `stop` are markers that look like identifiers but are text;
  // `skipPaths` are non-code paths and directories, where a search is plain text. `{tool}` is the harness's LSP tool.
  "lsp": {
    "programs": ["grep", "egrep", "rg", "ugrep", "git grep"],
    "declaration": "(?:^|[\\s^(])(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:def|class|function|func|interface|struct|trait|enum)(?:\\s+|\\\\s[+*]?|\\[\\[:space:\\]\\][+*]?)(?:\\([^)]*\\)\\s*)?[A-Za-z_]\\w*",
    "identifier": "^(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)$",
    "ext": ["py", "pyi", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go"],
    "types": ["py", "python", "ts", "typescript", "js", "go"],
    "stop": ["TODO", "FIXME", "XXX", "HACK", "NOTE"],
    "skipPaths": "\\.(?:md|mdx|txt|json|ya?ml|toml|lock|log|csv|ini|cfg)$|(?:^|/)(?:node_modules|dist|build|\\.git|logs?|docs)(?:/|$)",
    "say": "This looks like a symbol search: use the `{tool}` tool (definitions, references, callers, workspace symbols) where a language server covers the file; keep grep for text, config and languages without one."
  },
  // Subagent spawns that bypass the typed agents: a once-per-session hint per case, never a deny. `tools` are the
  // spawn tools whose input names the agent type and model: Claude Code `Agent` (`Task` before 2.1.63, `subagent_type`),
  // Copilot CLI `task` and Codex `spawn_agent` (`agent_type`), VS Code `runSubagent` (`agentName`). `typed` are the agents that carry their own
  // model and effort, as `plugin:name`. A bare name matches too (Codex and opencode drop the plugin), except a Codex
  // built-in role (`codexBuiltin`) on `spawn_agent`; `aliases` are names an agent registers under elsewhere (Codex
  // `dev-tools-worker`). `overrides` are the spawn values the `subagent-orchestration` and `ticket-run` routing tables
  // allow them; `modelNeeds` is the effort a spawn's model is allowed only with (a sensitive review: Opus at `high`).
  // `untyped` are the generic agents (Codex `default`).
  "routing": {
    "tools": ["agent", "task", "spawn_agent", "runsubagent"],
    "typed": ["dev-tools:scout", "dev-tools:worker", "dev-tools:driver", "dev-tools:reviewer", "dev-tools:escalate", "api:api-reviewer", "factory:verifier"],
    "aliases": { "dev-tools-worker": "dev-tools:worker" },
    "codexBuiltin": ["default", "worker", "explorer"],
    "overrides": { "factory:verifier": { "model": "sonnet|opus", "effort": ["medium", "high"] }, "dev-tools:reviewer": { "model": "opus", "modelNeeds": "high", "effort": ["medium", "high"] } },
    "untyped": ["general-purpose", "claude", "task", "default"],
    "plan": ["plan"],
    "judgementModel": "opus|fable|\\bsol\\b|\\bastra\\b",
    "skill": "subagent-orchestration"
  },
  "deny": [
    {
      "id": "pip",
      "when": "uv",
      // At command position only (D13): `which pip`, `ls .venv/bin/pip` or `git log --grep pip` pass, and so do
      // read-only `pip list`/`pip freeze`; `uv pip …` is uv's own.
      "match": "(?:^|[;&|(\\n]\\s*|\\bsudo\\s+|/)(?:pip[\\d.]*\\s+(?:install|uninstall|download|wheel)|pipx\\s+(?:install|run|inject|upgrade|reinstall))\\b|\\bpython[\\d.]*\\s+-m\\s*pip\\s+(?:install|uninstall|download|wheel)\\b",
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
  // `say`: what the rule's command does, in plain words, at the top of the ask (the rm family, branch-delete and
  // force build theirs from the targets).
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
      "say": "Discards uncommitted changes (git reset --hard)",
      "match": "\\bgit\\s+reset\\b[^;&|\\n]*\\s--hard\\b",
      "why": "discards local work",
      "prefixes": [["git", "reset", "--hard"]]
    },
    {
      "id": "clean",
      "say": "Deletes untracked files, which git cannot restore",
      "match": "\\bgit\\s+clean\\b(?![^;&|\\n]*\\s(?:-[a-z]*n[a-z]*|--dry-run)\\b)(?=[^;&|\\n]*\\s(?:-[a-z]*f[a-z]*|--force)\\b)",
      "why": "deletes untracked files, which git cannot restore",
      "prefixes": [["git", "clean", "-f"], ["git", "clean", "-fd"], ["git", "clean", "-df"], ["git", "clean", "-fdx"], ["git", "clean", "-dfx"], ["git", "clean", "-xdf"], ["git", "clean", "-fx"], ["git", "clean", "-xf"], ["git", "clean", "-ffdx"], ["git", "clean", "--force"]]
    },
    {
      // A whole-tree or directory pathspec (`.`, `:/`, `dir/`, a glob), or a forced checkout or switch. One named
      // file (`git checkout -- f`, `git restore f`) passes: a narrow, deliberate revert. `restore --staged` only unstages.
      "id": "discard",
      "say": "Discards uncommitted changes in the working tree",
      "match": "\\bgit\\s+checkout\\b[^;&|\\n]*\\s(?:-f|--force|\\.{1,2}/?|:/?|:\\([^)\\s]*\\)\\S*|[^\\s;&|]*[*?][^\\s;&|]*|[^\\s;&|]+/)(?=[\\s;&|)]|$)|\\bgit\\s+switch\\b[^;&|\\n]*\\s(?:-f|--force|--discard-changes)\\b|\\bgit\\s+restore\\b(?=[^;&|\\n]*\\s(?:--worktree|-W)\\b|(?![^;&|\\n]*\\s(?:--staged|-S)\\b))[^;&|\\n]*\\s(?:\\.{1,2}/?|:/?|:\\([^)\\s]*\\)\\S*|[^\\s;&|]*[*?][^\\s;&|]*|[^\\s;&|]+/)(?=[\\s;&|)]|$)",
      "why": "discards uncommitted changes, which git cannot restore",
      "prefixes": [["git", "checkout", "."], ["git", "checkout", "--", "."], ["git", "checkout", "-f"], ["git", "checkout", "--force"], ["git", "restore", "."], ["git", "switch", "-f"], ["git", "switch", "--force"], ["git", "switch", "--discard-changes"]]
    },
    {
      "id": "stash",
      "say": "Drops stashed work",
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
      // `--force-if-includes` alone is not a force push; a lease push naming main or master anywhere is.
      "match": "\\bgit\\s+push\\b[^;&|\\n]*(--force(?![\\w-])|\\s-[a-z]*f[a-z]*\\b|\\s\\+[^\\s;&|])|\\bgit\\s+push\\b(?=[^;&|\\n]*--force-with-lease\\b)[^;&|\\n]*[\\s:](?:refs/heads/)?(main|master)(?=[\\s;&|)]|$)",
      "why": "rewrites remote history",
      "prefixes": [["git", "push", "--force"], ["git", "push", "-f"]]
    },
    {
      // Deleting a feature branch on the remote passes; main and master do not.
      "id": "push-delete",
      "say": "Deletes branches on the remote",
      "match": "\\bgit\\s+push\\b[^;&|\\n]*\\s(?:--mirror|--prune)\\b|\\bgit\\s+push\\b(?=[^;&|\\n]*\\s(?:--delete|-d)\\b)[^;&|\\n]*\\s(?:refs/heads/)?(?:main|master)(?=[\\s;&|)]|$)|\\bgit\\s+push\\b[^;&|\\n]*\\s:(?:refs/heads/)?(?:main|master)(?=[\\s;&|)]|$)",
      "why": "deletes remote branches",
      "prefixes": [["git", "push", "--mirror"], ["git", "push", "--prune"]]
    },
    {
      "id": "git-rm",
      "say": "Removes files and drops their uncommitted changes",
      "match": "\\bgit\\s+rm\\b(?![^;&|\\n]*\\s--cached\\b)(?=[^;&|\\n]*\\s(?:-[a-z]*f[a-z]*|--force)\\b)",
      "why": "drops uncommitted changes to the removed files",
      "prefixes": [["git", "rm", "-f"], ["git", "rm", "-rf"], ["git", "rm", "-fr"], ["git", "rm", "--force"]]
    },
    {
      "id": "terraform",
      "say": "Applies or destroys real infrastructure",
      "match": "\\b(?:terraform|tofu)\\b(?:\\s+-[\\w-]+(?:=\\S+)?)*\\s+(?:apply|destroy)\\b",
      "why": "changes real infrastructure",
      "prefixes": [["terraform", "apply"], ["terraform", "destroy"], ["tofu", "apply"], ["tofu", "destroy"]]
    },
    {
      // Refs git cannot restore from the remote: a deleted ref, a rewritten history, main or master moved by force.
      "id": "rewrite",
      "say": "Rewrites history or moves a ref git cannot restore from the remote",
      "match": "\\bgit\\s+update-ref\\b[^;&|\\n]*\\s-d\\b|\\bgit\\s+filter-(?:repo|branch)\\b|\\bgit\\s+branch\\b[^;&|\\n]*\\s(?:-f|--force)\\b[^;&|\\n]*\\s(?:refs/heads/)?(?:main|master)(?=[\\s;&|)]|$)",
      "why": "rewrites history or a ref on main",
      "prefixes": [["git", "update-ref", "-d"], ["git", "filter-repo"], ["git", "filter-branch"]]
    },
    // Data-loss forms outside git (owner decision D3). Routine `docker rm`/`rmi` of disposable containers and
    // images, `docker image prune` and `docker stack rm` stay allowed.
    {
      "id": "docker",
      "say": "Deletes container data volumes",
      "match": "\\b(?:docker|podman)\\s+volume\\s+(?:rm|remove|prune)\\b|\\b(?:docker|podman)\\s+system\\s+prune\\b|\\b(?:docker|podman)\\s+(?:container\\s+)?rm\\b[^;&|\\n]*\\s(?:-[a-z]*v[a-z]*|--volumes)\\b|\\b(?:docker[\\s-]compose|podman-compose)\\b[^;&|\\n]*\\s(?:down|rm)\\b[^;&|\\n]*\\s(?:-[a-z]*v[a-z]*|--volumes)\\b",
      "why": "deletes container data volumes",
      "prefixes": [["docker", "volume", "rm"], ["docker", "volume", "prune"], ["docker", "system", "prune"], ["docker", "rm", "-v"], ["docker", "compose", "down", "-v"]]
    },
    {
      "id": "gh-delete",
      "say": "Deletes a GitHub repository, release, secret or resource",
      "match": "\\bgh\\s+(?:repo|release|secret)\\s+delete\\b|\\bgh\\s+api\\b(?=[^;&|\\n]*\\s(?:-X|--method)[\\s=]*DELETE\\b)",
      "why": "deletes on GitHub, which cannot be undone",
      "prefixes": [["gh", "repo", "delete"], ["gh", "release", "delete"], ["gh", "secret", "delete"]]
    },
    {
      "id": "k8s",
      "say": "Deletes Kubernetes resources or a Helm release",
      "match": "\\bkubectl\\b(?:[^;&|\\n]*\\s)?delete\\b|\\bhelm\\s+(?:uninstall|delete|del|un)\\b",
      "why": "deletes cluster resources and their data",
      "prefixes": [["kubectl", "delete"], ["helm", "uninstall"], ["helm", "delete"]]
    },
    {
      // No prefixes: a cloud CLI's delete sits after a resource path, so no first-word prefix covers it.
      "id": "cloud-delete",
      "say": "Deletes a cloud resource",
      "match": "\\b(?:gcloud|az)\\b[^;&|\\n]*\\sdelete\\b",
      "why": "deletes cloud resources, which cannot be undone"
    },
    {
      "id": "disk",
      "say": "Overwrites or formats a disk",
      "match": "\\bdd\\b[^;&|\\n]*\\sof=/dev/|\\bmkfs(?:\\.\\w+)?\\b|\\bdiskutil\\s+(?:erase\\w*|zeroDisk|secureErase|partitionDisk|reformat)\\b",
      "why": "overwrites a disk",
      "prefixes": [["mkfs"], ["diskutil", "eraseDisk"], ["diskutil", "eraseVolume"]]
    },
    {
      "id": "merge",
      "say": "Merges past the branch rules",
      "match": "\\bgh\\s+pr\\s+merge\\b[^;&|\\n]*--admin|\\baz\\s+repos\\s+pr\\s+(create|update)\\b[^;&|\\n]*--bypass-policy\\b(?![\\s=]+false)",
      "why": "bypasses merge rules"
    },
    // Matched on what runs, so a token injected through a quoted `VAR="$(keyring read)" ./script` passes
    // (`skipInjected`): the value goes to one process's environment, never to output. `echo "$(bws secret get x)"` asks.
    // `pipeline` + `help`: judged per pipeline, leaving out a command that only prints its usage (`--help`, `-h`, `help`).
    {
      "id": "secrets",
      "say": "Reads a secret",
      "pipeline": true,
      "help": true,
      "match": "\\bbws?\\s+(secret|get|list|run|unlock|login|export|serve)\\b|\\bsecurity\\s+find-(generic|internet)-password\\b[^|;&\\n]*\\s-[a-z]*[wg][a-z]*\\b|\\bsecurity\\s+dump-keychain\\b|\\bchezmoi\\s+secret\\s+keyring\\s+get\\b|\\bop\\s+read\\b|\\bop\\s+item\\s+get\\b[^|;&\\n]*\\s--reveal\\b|\\bpass\\s+show\\b|\\bgcloud\\s+secrets\\s+versions\\s+access\\b|\\baz\\s+keyvault\\s+secret\\s+show\\b|\\bgh\\s+auth\\s+token\\b|\\bgh\\s+auth\\s+status\\b[^;&|\\n]*--show-token\\b|\\bgcloud\\s+auth\\s+(?:application-default\\s+)?print-(?:access|identity)-token\\b|\\baz\\s+account\\s+get-access-token\\b|(?:^|[;&|(\\n]\\s*)printenv\\s+\\w*(token|secret|key|pass|credential)|(?:^|[;&|(\\n]\\s*)(?:env|printenv)\\s*(?=$|[;&\\n)]|\\|(?!\\s*(?:e?grep|rg|findstr|select-string)\\b))|\\b(?:cat|less|more|head|tail|bat|grep|egrep|rg|sed|awk|cut|xxd|strings|base64|jq)\\b[^;&|\\n]*\\s(?:[^\\s;&|]*/)?(?:\\.env(?:rc|\\.(?!example\\b|sample\\b|template\\b|dist\\b)[\\w.-]+)?|\\.netrc|\\.aws/credentials|\\.ssh/id_(?:rsa|ed25519|ecdsa|dsa))(?=[\\s;&|)]|$)|(?:^|[;&|(\\n]\\s*)(?:source|\\.)\\s+(?:[^\\s;&|]*/)?(?:\\.env(?:rc|\\.(?!example\\b|sample\\b|template\\b|dist\\b)[\\w.-]+)?|\\.netrc|\\.aws/credentials|\\.ssh/id_(?:rsa|ed25519|ecdsa|dsa))(?=[\\s;&|)]|$)|<\\s*(?:[^\\s;&|]*/)?(?:\\.env(?:rc|\\.(?!example\\b|sample\\b|template\\b|dist\\b)[\\w.-]+)?|\\.netrc|\\.aws/credentials|\\.ssh/id_(?:rsa|ed25519|ecdsa|dsa))(?=[\\s;&|)]|$)",
      "why": "reads a secret; load `secrets-handling` and never print or inline the value",
      "skipInjected": true,
      "prefixes": [
        ["bw", "get"], ["bw", "list"], ["bw", "unlock"], ["bw", "login"], ["bw", "export"], ["bw", "serve"],
        ["bws", "secret"], ["bws", "get"], ["bws", "list"], ["bws", "run"],
        ["chezmoi", "secret", "keyring", "get"], ["op", "read"], ["pass", "show"],
        ["gcloud", "secrets", "versions", "access"], ["az", "keyvault", "secret", "show"],
        ["cat", ".env"], ["less", ".env"],
        ["gh", "auth", "token"], ["gcloud", "auth", "print-access-token"], ["az", "account", "get-access-token"], ["security", "dump-keychain"]
      ]
    },
    // Echoing a secret variable (D9): `match` finds the echo, `raw` the variable as written (it is usually quoted).
    // Names ending in TOKEN, KEY, SECRET or PASSWORD; `$KEY_PATH` passes.
    {
      "id": "secrets",
      "say": "Prints a secret variable",
      "match": "(?:^|[;&|(\\n\\s])(?:echo|printf|write-output|write-host)\\b",
      "raw": "(?:echo|printf|write-output|write-host)\\b[^;&|\\n]*\\$(?:\\{|env:)?(?:\\w*_)?(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)\\}?(?!\\w)|(?:echo|printf)\\b[^;&|\\n]*\\$\\{?\\w*PASSWORD\\}?(?!\\w)",
      "why": "prints a secret variable; load `secrets-handling` and never print the value",
      "skipInjected": true
    },
    // `raw` must also match the command as written: the grep pattern is usually quoted, which `match` cannot see.
    // `pipeline`: match, raw and unless are tested per pipeline, so a secret word elsewhere in the command does not
    // count (G09). `unless`: a pipeline that ends by keeping only the names (`cut -d= -f1`) prints no value.
    {
      "id": "secrets-env",
      "pipeline": true,
      "unless": "\\|\\s*(?:cut\\s+-d\\s*['\"]?=['\"]?\\s+-f\\s*1|cut\\s+-f\\s*1\\s+-d\\s*['\"]?=['\"]?|sed\\s+(?:-E\\s+)?['\"]?s/=\\.\\*//['\"]?|awk\\s+-F\\s*['\"]?=['\"]?\\s+['\"]?\\{\\s*print\\s+\\$1\\s*\\}['\"]?)\\s*$",
      "say": "Prints environment variables that hold secrets",
      "match": "(^|[;&|(\\n]\\s*)(printenv|env)\\b(?![-.=])[^;&\\n]*\\|\\s*(e?grep|rg|findstr|select-string)\\b",
      "raw": "token|secret|key|pass|credential|\\btok|gh_|\\bpat\\b|bearer",
      "why": "dumps secret environment variables; load `secrets-handling` and filter to names only",
      "skipInjected": true
    },
    {
      // core/shell.mjs marks what runs but cannot be read: an encoded PowerShell command, base64 decoded into a
      // shell, payloads nested more than three levels deep.
      "id": "opaque",
      "say": "Runs a command the guard cannot read",
      "match": "<guard:opaque>",
      "why": "runs a command the guard cannot read (encoded, decoded at run time, or nested too deep)"
    }
  ],
  // The factory approval and takeover labels (config `labels.approval`, `labels.takeover`, defaults below) are never touched
  // (applied or removed) while FACTORY_RUN_ID is set.
  "factory": {
    "approval": "agent-ok",
    "why": "A factory run must not touch the approval label: with an owner token the runtime would read it as the owner's approval.",
    "takeover": "factory-takeover",
    "takeoverWhy": "A runtime run must not touch the takeover label: it hands the ticket from a runtime to an attended run, and only an approver sets it.",
    "unsureWhy": "The repo's .factory/config.yaml exists but could not be read, or its labels could not be parsed, so the guard cannot tell which labels a factory run must not touch.",
    // gh's own commands, their aliases and help topics (gh 2.102 `gh help` and each command's ALIASES). Any other `gh <name>`
    // is an alias or extension (`stack`, an extension; `co`, a default alias stored in the user's gh config, so one a run can replace), and
    // `gh alias set|import` or `gh extension install|upgrade|remove|exec` makes, swaps or runs one: the command it runs is
    // unseen. `copilot` is left out: it starts an agent whose commands the guard never sees. On an older gh, a name that is a
    // built-in only in a later release may be an extension: this list still lets it pass. Newer built-ins deny until listed.
    "ghCommands": ["a11y", "accessibility", "actions", "agent", "agent-task", "agent-tasks", "agents", "alias", "api", "at", "attestation", "auth", "browse", "cache", "codespace", "completion", "config", "cs", "discussion", "environment", "exit-codes", "ext", "extension", "extensions", "formatting", "gist", "gpg-key", "help", "issue", "label", "licenses", "mintty", "org", "pr", "preview", "project", "reference", "release", "repo", "rs", "ruleset", "run", "search", "secret", "skill", "skills", "ssh-key", "status", "telemetry", "variable", "version", "workflow"],
    "ghUnseenWhy": "In a factory run every gh command must be one the guard can read: a gh alias or extension can run any command, a label change included, out of its sight.",
    // Repo-relative globs a run's shell never writes (rule `protected-path`); FACTORY_PROTECTED_PATHS adds to them.
    "protectedPaths": [".github/**", ".factory/**"],
    // Waived from the two defaults only (an explicit FACTORY_PROTECTED_PATHS glob still protects): files inside a run directory (the run's own outputs).
    "exemptPaths": [".factory/runs/*/*/**"],
    // Past any of these a command that may write is denied (a hook that times out lets the command through): write
    // targets in one command, characters in a target, milliseconds for the check. Globs past `globs` (defaults counted
    // first) or over `chars` are ignored.
    "protectedLimits": { "globs": 256, "targets": 512, "chars": 1024, "ms": 2000 },
    "protectedWhy": "A factory run must not change a protected path (CI, the factory config, or one the runtime lists): those changes are the owner's."
  },
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
    "throttlePercent": 90,
    "throttleMode": "warn"
  }
}
