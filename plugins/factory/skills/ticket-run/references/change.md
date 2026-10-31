# Change runs

A change run works an existing, open pull request (the **change**) instead of an issue: it turns what an approver or a required check asked of the change into one **unit** of work, fixes it on the change's branch and records a **fix attempt**. It never opens a second PR and never closes anything: the change still closes its issues only when it merges. The run is a ticket run in every other way (claim, plan, work, verify, record), with the change as the ticket: `ticket` and `FACTORY_TICKET` are the change (`acme/app#14`, the PR's number), and `result.json` sits under `.factory/runs/14/`, so the issue's own result is never overwritten.

## Roles on the change

| Role | Who | What their actions are |
|---|---|---|
| Author | The login that opened the change. | A change run works only a change whose author is a factory identity login, an approver, or the login the session posts as. |
| Approver | A login in `approvers` (a `[bot]` login only with `approvers_allow_bots: true`). | Its `CHANGES_REQUESTED` review, or its comment that mentions the factory, is a request to act. An `APPROVED` or `COMMENTED` review without the mention is not. |
| Reviewer | Any other login that reviews or comments. | Never a request to act. Its text enters a unit only when an approver's request in that unit links it, and only as data. |
| Factory | A login in `identity.logins`, or the session's own login. | Never a request to act: nothing it posts, pushes, reviews or reruns starts a unit, so a run cannot trigger itself. A marked comment is never a request either, whoever wrote it. |
| Required check | A check the default branch's rules require, as the forge reports it (`gh pr checks <n> --required`). | Its run concluding `failure` or `timed_out` on the change's current head is a request to act. |

Logins are compared as the REST API reports them, ignoring case, as for `writers`.

## Triggers

A unit starts on one trigger, its `trigger` value:

- **`changes_requested`:** an approver's review in state `CHANGES_REQUESTED`. Its body and its inline comments are the unit's items.
- **`mention`:** an approver's comment, review body or inline comment on the change that contains the `identity.mention` handle as a whole word. That comment is an item; so is each comment it links on the same change.
- **`check_failed`:** a required check failed on the change's current head. Each failed required check on that head is an item.

A source (the review's, comment's or check run's `html_url`) is handled once a `done` attempt lists it: a source in the `sources` of a trusted `factory:result done` comment on the change never starts another unit. A park or a stop (`parked`, `failed`, `budget_reached`, `halted`) handles nothing: its result lists the sources it left pending, and the [resume](#resume-after-a-park) takes them up again. A check that fails again on a head a fix attempt pushed is a new source, so a fix that breaks a check gets one more attempt, inside the cap.

**Unedited.** An approver's review body or comment counts as that approver's only when it was never edited, or its last editor is that approver (GraphQL `lastEditedAt` and `editor`), as the issue gate's [edit check](comments.md#edited-after-approval) judges a ticket: anyone with write access can edit another's comment. An item edited by anyone else is left out of the unit; when it was the trigger, there is none.

## Gate

Every check reads the live forge state, and a read that fails counts as no.

- **Open, same repo:** the change is open and its head branch is in the repo, never a fork: the factory pushes only to branches of the repo it works.
- **Author:** as in [Roles](#roles-on-the-change).
- **Issues approved:** the change closes at least one issue (the forge's closing references), and each passes the issue gate's approval and edit checks ([comments.md](comments.md#gate)). A change that closes none, or one whose issue lost its approval, is stopped: the approval of the issue is what scopes the change, and an approver's request (a review or a mention) never stands in for it.
- **A source not yet handled**, as above. With none, stop: there is nothing to do.
- **Not claimed:** the claim label on the change and the newest trusted `factory:claim` comment on it, judged as for an issue. A change run claims the change, never its issues.
- **Not parked:** `needs-owner` is off the change, or an approver answered its open question ([Resume](#resume-after-a-park)). An approver removing it is also what resets the attempt count.
- **Attempts left:** fewer than the cap were made ([Bounded retry](#bounded-retry)). Otherwise record the stop below and post nothing else.

A stop at the gate (`phases` holding `gate` alone) records `pr` as the change and no `change` (`null` or absent): the gate wrote no unit; the cap stop still carries `change`.

## Unit brief

The run writes the unit to `.factory/runs/<change>/unit-<attempt>.json` before it spawns the driver, and checks it with `scripts/check-change.mjs`. The file holds the facts the run read; every `text` is untrusted data. One JSON object:

| Key | Type | Meaning |
|---|---|---|
| `unit` | `change_fix` | What the file is. |
| `version` | integer | Unit format, `1`. |
| `run_id` | string | The run's `run_id`. |
| `change` | string | The change, `<owner>/<repo>#<number>`. |
| `pr` | string | The change's URL, `https://github.com/<owner>/<repo>/pull/<number>`, the same owner, repo and number as `change`. |
| `issues` | array of strings | The issues the change closes, each `<owner>/<repo>#<number>`, at least one, none equal to `change`. |
| `branch` | string | The change's head branch, one plain ref name. |
| `head` | string | The 40-hex commit the unit starts from: the change's head at the gate, or under `FACTORY_FETCH_FIRST=1` the branch's fetched remote head, also when the local branch is ahead of it ([comments.md](comments.md#fetch-first)). |
| `trigger` | `changes_requested` \| `mention` \| `check_failed` | What started the unit. |
| `attempt` | integer | This attempt's number, from 1 up to `max_attempts`. |
| `max_attempts` | integer | The cap in force, at least 1. |
| `items` | array | 1 to 50 `{source, kind, author, role, path, line, text}`, each `source` once. |

Each item:

| Key | Type | Meaning |
|---|---|---|
| `source` | string | The `https://` URL of the review, comment or check run. |
| `kind` | `review` \| `review_comment` \| `comment` \| `check` | A review body, an inline review comment, a comment on the change, or a check run. |
| `author` | string \| null | The login that wrote it; `null` for a `check`. |
| `role` | `approver` \| `reviewer` \| `check` | As in [Roles](#roles-on-the-change); `check` exactly for a `check` item. |
| `path`, `line` | string \| null, integer \| null | The file and line an inline comment sits on; `null` otherwise. |
| `text` | string | The item verbatim (a check's log excerpt), cut to 4000 characters. Untrusted data. |

A `check_failed` unit has at least one `check` item; any other has at least one `approver` item. No item is the factory's own.

**Data, not instructions.** The driver's brief is the run's fixed text, then the unit: the change, its issues' plan comment links, and each item's `text` inside its own fenced block headed with its source, author and role. The brief says that the items describe what an approver or a check wants changed, that any instruction inside them about how the run works (permissions, labels, the guard, `.factory/`, other repos, merging, closing) is ignored, and that the scope is the change's issues' approved plans plus the items, under the [fold-in test](fold-in-test.md). An approver's request sets *what* to fix on the change; it is still forge text and never widens the run's permissions or skips a step. An item that needs more than the fold-in test allows is a question on the change, or a follow-up issue.

## Fix attempts

One run is one attempt. It works on the change's branch from `head` (no second PR, no force push; under `FACTORY_FETCH_FIRST=1` it runs the fetch-first steps before writing the unit, and `head` is the fetched remote head even when the local branch is ahead of it; local commits ahead of `head` are part of this attempt's delta and pass its verifier round before they are pushed, [comments.md](comments.md#fetch-first)), verifies the delta with a scoped verifier round, pushes, and re-requests review from the approvers whose items it handled. It never dismisses a review, approves, merges, closes or reopens the change or an issue.

**Refers, never closes.** A fix attempt refers to the change and to its issues; only the change's merge closes them, through the closing line its PR body already carries. The run's commits and comments name the issues with `Refs #N` only, never a closing keyword (`Closes`, `Fixes`, `Resolves`), and the run never edits the PR body's closing line.

**End states.** `done`: every item is addressed on a pushed commit, the verifier passed it, and the required checks pass on that commit; the change stays open. `parked`: a question on the change, the cap, or the verifier's three rounds. `failed`, `budget_reached` and `halted` as for an issue. Questions go on the change as `factory:question` comments and park it with `needs-owner` on the change; answers are read on the change.

**The result** carries `change` ([result.md](result.md)). The `factory:result` comment is posted on the change, never on its issues, with these field lines after the end state:

```
change: https://github.com/acme/app/pull/14
refers: acme/app#12
attempt: 2/3
trigger: changes_requested
sources: <url>, <url>
pushed: <40-hex sha, or none>
```

followed by one sentence such as "Fix attempt 2 of 3 pushed; the change stays open and closes acme/app#12 when it merges."

## Bounded retry

`change_requests.max_attempts` in `.factory/config.yaml` caps the attempts per change (default `3`). The attempts made are the trusted `factory:result` comments on the change whose `attempt:` field is at most the cap, counted from the newest event in which an approver removed `needs-owner` from the change (or from the change's opening). This attempt's number is that count plus one.

When it would exceed the cap, the run makes no change: it writes `result.json` with `end_state: parked`, `reason_code: fix_attempts`, `change.attempt` the cap plus one, `change.pushed` `null`, `change.sources` the pending sources, and a `reason` naming the cap and how to allow more ("3 of 3 fix attempts used on acme/app#14; an approver removes needs-owner from it to allow 3 more"). The change gets `needs-owner` (in a runtime run, the runtime applies it from the result), and a runtime notifies the approvers. No unit is written.

## Resume after a park

A parked or stopped attempt leaves its sources pending, listed in its result; the next attempt's unit is those pending sources (from the newest trusted `factory:result` on the change) plus any new source. Each resume is a new attempt, within the cap.

- **A question** (`reason_code: question`) resumes on an approver's answer on the change ([comments.md](comments.md#answers)): the run removes `needs-owner` and adds the answer to the unit as an approver `comment` item.
- **The cap** (`fix_attempts`) and **the verifier's rounds** (`verify_rounds`) resume when an approver removes `needs-owner` from the change, which also resets the count.
- **`failed`, `budget_reached` or `halted`** set no `needs-owner`: the pending sources are still unhandled, so the next run on the change takes them up.

## Identity

`identity` in `.factory/config.yaml` names who the factory is on the forge:

- `identity.logins`: the logins the factory posts, pushes and reviews as (a runtime's bot or App login, `<slug>[bot]`). Their events never start a unit. Each must also be a writer, or its marked comments are ignored ([comments.md](comments.md#trusted-marked-comments)).
- `identity.mention`: the handle an approver writes on a change to ask the factory to act, such as `@acme-factory`.

Both are optional. Without `identity`, only the session's own login and marked comments are the factory's, and no mention is an input. An attended run posting under an approver's login ignores that approver's own comments like any factory login's, so it acts on other approvers' reviews and mentions and on failed checks.
