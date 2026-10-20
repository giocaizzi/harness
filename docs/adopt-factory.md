# Adopt the factory in a repo

**When:** a repo with a GitHub issue board should have tickets worked by the `factory` plugin ([factory.md](factory.md)). Not for repos on other forges.
**Preconditions:** admin or maintain access to the repo; `gh` authenticated as an account that can create labels; the `factory` plugin installed in your harness ([install.md](install.md)). Run the steps from the root of a checkout of the target repo, on a branch (the config lands through a PR like any other change).

## Steps

1. Create the labels (skip one that exists; to use other names, set them under `labels` in step 3):
   ```bash
   gh label create agent-ok --color 0E8A16 --description "Approved for an agent run (owner only)"
   gh label create needs-owner --color D93F0B --description "An agent question waits on the owner"
   gh label create needs-grooming --color FBCA04 --description "Parked three times: refine before the next run"
   ```
2. Add the config template and ignore run results:
   ```bash
   mkdir -p .factory
   gh api repos/giocaizzi/harness/contents/plugins/factory/template/config.yaml -H "Accept: application/vnd.github.raw" > .factory/config.yaml
   printf '\n# factory run results (docs/factory.md in giocaizzi/harness)\n.factory/runs/\n' >> .gitignore
   ```
3. Edit `.factory/config.yaml`: replace every `<placeholder>`, list the repo's components with their checks and deploy commands, and set the risk tiers. Keys: [factory.md](factory.md#config-factoryconfigyaml). Check nothing is left:
   ```bash
   grep -n '<' .factory/config.yaml
   ```
4. If the repo has a project board, fill `board` with its owner, number and the status field's option names (`gh project field-list <number> --owner <owner>` lists them); otherwise delete the `board` block.
5. Link the factory from the repo's `AGENTS.md` (one line: tickets labelled `agent-ok` are worked with the `ticket-run` skill; config in `.factory/config.yaml`), then commit and open a PR.

## Verify

- `gh label list --search agent-ok` lists the three labels.
- `grep -n '<' .factory/config.yaml` prints nothing, and `git check-ignore .factory/runs/x` prints the path.
- On an open test issue with the approval label applied by you, `factory-status` lists it, and `ticket-run <number>` passes the gate and posts a plan comment.

## Rollback

Delete the labels (`gh label delete <name> --yes`) and the `.factory/` folder in a PR. Comments already posted on tickets stay; they are marked and harmless.

**Last verified:** not yet run against a repo; commands checked against `gh` 2.x documentation, 2026-10-20.
