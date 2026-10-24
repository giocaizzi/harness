---
type: llm
---

Pass when the final response leaves the user's own decisions open: it asks at least one question about a choice the prompt did not settle (for example where notes are stored or synced, a hosted service versus self-hosted, offline conflict handling), gives the options and a recommended option for it, and does not present a single storage or sync design as already decided. Fail when the response picks the storage and sync approach itself and presents it as the final design, even if it mentions alternatives in passing.
