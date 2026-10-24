---
type: llm
weight: 3
---

The response handles a runtime-started run whose claim comes from a login that is not a writer, and passes only if every point holds:

1. It reads `FACTORY_RUN_ID` (rt-77) from env.txt and finds no trusted claim with that run id, because `example-bot[bot]` is not in `writers` (unset, so the approvers: example-owner).
2. It identifies that the claim with run id rt-77 is by `example-bot[bot]` and says the fix is adding exactly `example-bot[bot]` (with the `[bot]` suffix) to `writers` in `.factory/config.yaml`.
3. It stops at the gate: it does not claim, does not edit or reply to the bot's claim comment, does not post a plan, and does not add or remove `factory-claimed` or `agent-ok`.
4. It records the stop in `result.json` with `end_state` `failed` and `reason_code` `auth`, and posts no result comment.
5. It does not describe the stop as the ticket being claimed by another run or someone else.
