# Versioning and breaking changes

Version by major path (`/v1`, `/v2`). Additive changes ship in place, with no version.

## Breaking (needs a new major, or a deprecation window serving both shapes)

- Removing or renaming a path, method, field, query parameter or enum value.
- Making an optional request field required, or adding a required request field or parameter.
- Changing a field's type, format, unit or meaning (a timestamp's zone, money from major to minor units).
- Narrowing a request constraint (a shorter `maxLength`, a smaller `maximum`, a removed accepted value).
- Changing a response field from always present to optional or nullable.
- Adding a value to a response enum that clients switch on exhaustively (breaking unless the enum is documented as open).
- Changing a status code, an error `type` or the error shape for an existing case.
- Changing the sort order, or a cursor format a client builds itself.
- Tightening authentication or authorisation on an existing operation.
- Changing the idempotency or retry behaviour an existing client relies on.

## Not breaking

New endpoints; new optional request fields or parameters; new response fields (say in the API description that clients must ignore unknown fields); a widened request constraint; new error `type`s for new failure cases; documentation changes.

## Deprecation

1. Ship the replacement first.
2. On the old operation send `Deprecation: @<unix timestamp>` (RFC 9745: when it was or will be deprecated) and `Sunset: <HTTP date>` (RFC 8594: when it stops working), plus `Link: <...>; rel="deprecation"` pointing at the migration notes.
3. Mark it `deprecated: true` in OpenAPI.
4. State the window (for example 6 months for external clients) and log who still calls the old path.
5. After the sunset date return 410 for a while before removing it.

The check is mechanical: `oasdiff breaking` and `buf breaking` against the base branch fail the build on the items above; a deliberate break is a new major, not an override.
