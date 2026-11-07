# Design review rubric

For a reviewer assessing a design, architecture or API-contract change. Walk every item; report only failures, each with severity, evidence (file or section) and fix.

Severity: **blocker** (do not approve), **major** (fix before release or accept in writing), **minor** (note, may follow up).

| # | Check | Severity if failed |
|---|---|---|
| 1 | NFRs stated as numbers (latency, throughput, availability, RPO/RTO, cost) | blocker |
| 2 | Alternatives considered with the deciding reason; ADR for a new datastore, queue or service | major |
| 3 | Every outbound call: timeout shorter than the caller's, retry with backoff, jitter and budget, fallback | blocker |
| 4 | Retried operations are idempotent or carry an idempotency key | blocker |
| 5 | DB write plus event publish uses a transactional outbox, not two writes | blocker |
| 6 | Every consumer idempotent; dedupe key stored with the effect transactionally | blocker |
| 7 | Async paths name retry, DLQ, ordering key, expected lag | major |
| 8 | Consistency stated per boundary; eventual has a staleness bound | major |
| 9 | Schema change on live data is expand/contract; no in-place rename; backfill apart from the constraint | blocker |
| 10 | Rollback plan for each deploy step | major |
| 11 | Failure of each dependency analysed (down, slow, wrong) | major |
| 12 | One writer per datum; no tables shared across contexts | major |
| 13 | API change is additive or versioned; breaking change flagged with a deprecation window (detail: `api-design`) | blocker if an unflagged break |
| 14 | Authn/authz and data-class handling stated; security review for new endpoints | major |
| 15 | Metrics, alerts and trace propagation for the new path | major |
| 16 | Load estimate vs component limits; hot keys; unbounded queries or collections | major |
| 17 | Cost estimate and ceiling | minor (major if above ceiling) |
| 18 | Simplest option that meets the numbers; no speculative components | minor |
| 19 | Runbook or doc updated for an operational change | minor |

## Output

`<severity> #<n> <where>: <problem>. Fix: <action>.` End with a verdict: approve, approve with majors accepted, or block.
