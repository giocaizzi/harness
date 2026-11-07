# Pagination

Cursor pagination for every collection that can grow. Offset is acceptable only for a bounded, rarely changing list (a few dozen rows, such as the roles in a tenant).

## Contract

- Request: `?limit=50&cursor=<opaque>`. `limit` has a default and a hard cap (for example default 50, max 200); over the cap is clamped or a 422: pick one and document it.
- Response: `{"items": [...], "next_cursor": "<opaque>" | null}`. `null` means the end. Do not return a total count unless the client needs it: it costs a full scan; offer it on request (`?include_total=true`) when it does.
- The cursor is opaque to the client: an encoded `(sort key, id)` of the last row, optionally signed. Never document its content, so it can change. An invalid cursor is a 422 problem, not a 500.

## Query

- A stable total order: the sort key plus the id as tiebreaker (`ORDER BY created_at, id`). Without the tiebreaker, rows with equal keys are skipped or repeated across pages.
- Keyset condition, not `OFFSET`: `WHERE (created_at, id) > (:ts, :id) ORDER BY created_at, id LIMIT :limit + 1`. Fetch one extra row to know whether a next page exists.
- Index the sort columns together, in the same order and direction.
- A filter change invalidates a cursor: bind the cursor to the filter (include a hash of it) or reject a cursor used with different filters.

## Link headers

Optional: `Link: <...&cursor=...>; rel="next"` beside the body, for clients that follow links. The body field stays the source of truth.
