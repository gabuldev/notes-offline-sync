# Look up a batch of operation receipts

`POST /operations/lookup` reads previously recorded operation results. An offline client can use it to recover answers for several pending operations before deciding what to resend.

## Input

The JSON object contains only `op_ids`, an array of **1–1000** nonblank strings. Unknown envelope fields, wrong types and invalid array sizes return HTTP `400`. Identifiers are opaque strings. Validation may reject an all-whitespace value, but it must not trim or otherwise rewrite a valid identifier: `"a"` and `" a "` are different operation ids supported by the existing sync API.

## Output

For a valid request, respond HTTP `200` with `{ results: LookupResult[] }`. Return **one entry per requested occurrence in the original order**, including duplicate ids.

```ts
type LookupResult =
  | { op_id: string; status: 'found'; receipt: OpResult }
  | { op_id: string; status: 'not_found' };
```

A known id returns the **original stored receipt**, with the same note revision, text, proposal and operation id it had when processed. The stored result can be `applied`, `conflict` or `note_not_found`. Its contents remain historical even if the note changed later. `GET /notes` and `GET /notes/:id` continue to provide current state.

An unknown id produces `not_found` in its position; it does not fail the request. For input `["known", "missing", "known"]`, return three entries in that order, with equal receipts for both occurrences of `known`.

## State and scope

Lookup is read-only. Do not apply, replay, resolve, reserve ids or modify any note or receipt. A missing lookup does not occupy the id: a future valid sync operation may use it normally. A caller modifying a returned object must not affect stored state.

Keep the existing endpoints, synchronous in-memory engine and sync rules. No database, authentication, client UI or schema migration is required for this change.
