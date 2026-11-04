# Offline Notes Sync

**Case 05 — Offline notes synchronization**
**Focus:** back end (sync rules and API), with a browser simulator of offline clients for the demo
**Time spent:** _TODO: fill in (e.g. ~4 h)_
**Video:** _TODO: link_

A sync server that never silently overwrites work. A device sends an operation that says "I saw revision N of this note, replace the text with X". The server accepts it only if N is still the current revision. Otherwise it returns a conflict holding both the server's text and the client's proposal, and lets the person decide. Every valid operation's receipt is stored by `op_id`, so a client can safely resend after a network failure: it gets the original receipt back, and nothing is applied twice.

The project has three parts:

- **Domain** (`src/sync/domain`): the rules in plain TypeScript, with no framework and no I/O.
- **NestJS API** (`src/sync`): a thin layer over the domain.
- **Device simulator** (`public/`): up to four offline clients in one browser page, each with its own storage.

---

## Running it

Requires Node.js 20 or newer (developed on Node 26, npm 11).

```bash
npm install
npm run start          # API + simulator on http://localhost:3000
```

Tests:

```bash
npm test               # domain unit tests (35)
npm run test:e2e       # HTTP tests through the Nest app (8)
npm run lint
```

State is in memory: restarting the server clears it. The simulator's devices keep their own `localStorage`, so after a restart press **Reset devices** for a clean demo.

---

## Demo (reproducible)

This scenario is different from the example in the challenge. It shows offline edits, a lost response and a conflict being resolved.

Open http://localhost:3000. Two devices are on screen: _Ana's phone_ and _Ben's tablet_.

| # | Action | Expected result |
|---|---|---|
| 1 | **Ana:** type `groceries` in _New note name_ → **Create**. Type `milk` → **Save on device** → **Sync** | Server panel: `groceries` · `milk` · **v1** |
| 2 | **Ben:** **Sync** | Ben's list shows `groceries v1` |
| 3 | **Both:** **Go offline** | Pills turn _offline_ |
| 4 | **Ana:** select `groceries`, change it to `milk, bread`, **Save on device** | Ana's outbox: 1 op |
| 5 | **Ben:** select `groceries`, change it to `milk, eggs`, **Save**. Then change it to `milk, eggs, coffee`, **Save** again | Ben's outbox is still **1** op: an edit that was never sent is updated in place |
| 6 | **Ana:** **Go online** (sync runs automatically) | Server: `milk, bread` · **v2** |
| 7 | **Ben:** tick **Lose next response**, then **Go online** | Network log: _response lost on the way back_. Ben's outbox still has 1 op. The server **did** process it (it was a conflict), but Ben never got the answer |
| 8 | **Ben:** **Sync** again | Network log: same `op_id`, same content (expand the entry to compare). Ben receives the **original** conflict receipt and sees a conflict box: server `milk, bread` (v2) vs his `milk, eggs, coffee` |
| 9 | **Ben:** edit the merged text to `milk, bread, eggs, coffee` → **Send merged text** → **Sync** | Server: **v3**. Resolving the conflict sends a **new** `op_id` with base 2 |
| 10 | Copy Ben's first `op_id` from the network log into **Look up a receipt** | `"status": "conflict"` with `server_note.revision: 2`, while `GET /notes` shows **v3**. The receipt reflects the past; the query reflects the present |

Also worth trying: create the same note name offline on two devices. The second sync gets a conflict, because base 0 is used on a note that already exists.

### Same thing with curl

```bash
curl -s -X POST localhost:3000/sync -H 'content-type: application/json' -d '{"operations":[
  {"op_id":"a1","note_id":"trip","base_revision":0,"text":"Lisbon"},
  {"op_id":"b1","note_id":"trip","base_revision":0,"text":"Porto"},
  {"op_id":"a2","note_id":"trip","base_revision":1,"text":"Lisbon, 3 days"},
  {"op_id":"x","note_id":"trip","base_revision":"one","text":"?"},
  {"op_id":"a2","note_id":"trip","base_revision":1,"text":"Lisbon, 3 days"},
  {"op_id":"a2","note_id":"trip","base_revision":1,"text":"changed"}
]}'
# applied v1, conflict (base 0 on existing note), applied v2, invalid,
# resend of a2 -> same receipt (v2), id_reused

curl -s localhost:3000/notes/trip        # {"id":"trip","text":"Lisbon, 3 days","revision":2}
curl -s localhost:3000/operations/b1     # stored conflict receipt
```

---

## API

| Route | Description |
|---|---|
| `POST /sync` | Body `{ "operations": Operation[] }` (max 1000). Returns `{ "results": OpResult[] }`: one result per operation, in order. Always `200` when the envelope is valid. A bad operation becomes an `invalid` result instead of failing the batch. |
| `GET /notes` · `GET /notes/:id` | Current state (404 if the note does not exist). Read-only: notes change only through operations. |
| `GET /operations/:opId` | The stored receipt for an operation (404 if unknown). |

```ts
Operation = { op_id: string; note_id: string; base_revision: number; text: string }
Note      = { id: string; text: string; revision: number }
```

| `status` | Term in the challenge | Extra fields | Claims the `op_id`? |
|---|---|---|---|
| `applied` | accepted change | `note` (after the change) | yes |
| `conflict` | `conflito` | `server_note`, `proposal` | yes |
| `note_not_found` | "the note does not exist yet" | `proposal` | yes |
| `id_reused` | `id_reutilizado` | — | no (original receipt is kept) |
| `invalid` | invalid operation | `errors[]` | no |

Status values are in English so that the code, the API and the walkthrough video use the same language. The table maps each one to the term used in the challenge.

---

## How it works

Each operation goes through the same steps (`src/sync/domain/sync-engine.ts`):

```
validate ──invalid──▶ invalid        (nothing stored, op_id stays free)
   │
known op_id? ──yes──▶ same content? ──yes──▶ stored receipt (copy of the original)
   │                        └──no───▶ id_reused
   no
   ▼
note exists? ──no──▶ base 0? ──yes──▶ create at revision 1  ─┐
   │                     └──no───▶ note_not_found             ├─▶ store receipt
   yes                                                        │
   ▼                                                          │
base == revision? ──yes──▶ replace text, revision + 1  ───────┤
        └──no───▶ conflict (server note + proposal)  ─────────┘
```

- **Content identity.** Two operations have the same content when `[note_id, base_revision, text]` match. It is serialized as JSON, so no separator can be forged inside a field.
- **Receipts are immutable.** Repositories copy on write and on read (`structuredClone`), the way a database returns values instead of references. A receipt can't change after it is stored, even if the caller mutates the object it got back.
- **Atomic without locks.** `processOne` is fully synchronous: no `await` between reading the revision and writing the new one, so in Node's single thread no other request can interleave. The batch is processed with a plain `map`, so operations run strictly one after another, in order.

### Structure

```
src/sync/
  domain/                 plain TypeScript, imports nothing from @nestjs
    types.ts              Note, Operation, OpResult, StoredReceipt
    ports.ts              NotesRepository, ReceiptsRepository interfaces
    validate.ts           per-operation validation, reports every error at once
    sync-engine.ts        the rules
    sync-engine.spec.ts   unit tests
  infra/                  in-memory repositories
  dto/sync-request.dto.ts envelope contract (class-validator)
  sync.module.ts          wires repositories (by token) and the engine
  sync.controller.ts      POST /sync, GET /operations/:opId
  notes.controller.ts     GET /notes, GET /notes/:id
test/sync.e2e-spec.ts     the challenge example and the envelope contract over HTTP
public/                   device simulator (plain HTML/JS)
```

### The client (simulator)

`public/app.js` follows the rules a real offline client would:

- **`op_id` is created on the device** when the edit is queued, and it is stored with the operation. If the server generated it, a client whose response got lost could not prove that its retry is the same operation.
- **Edits coalesce.** An operation that was never sent can still be updated in place. Without this, three offline edits of one note would all carry the same base and conflict with each other.
- **A sent but unconfirmed operation is frozen** until its receipt arrives. Changing it would turn the retry into `id_reused`.
- **Resolving a conflict sends a new operation** with a new `op_id` and the server's current revision.

---

## Tests worth reading

There are 35 unit and 8 e2e tests. These three explain the solution best:

1. **A resent conflict returns the old receipt, while a query shows the present.** `sync-engine.spec.ts`: _"a conflict also claims the op_id: resend returns the same old conflict"_.
   A conflict at revision 2 is stored. The note then moves to revision 4, and the same operation arrives again. **Expected:** the identical conflict receipt (`server_note.revision: 2`) and no change to the note.
   **Catches:** receipts built from current state instead of stored, receipts stored only for successful operations, and receipts kept by reference and mutated later. Each of these makes the test fail.

2. **An invalid operation does not claim its `op_id`, and validation runs before deduplication.** `sync-engine.spec.ts`, two tests in _validation_.
   An operation with `base_revision: "zero"` is `invalid`, and afterwards a valid operation with the same `op_id` is applied normally. In the other direction, an invalid payload that reuses a stored `op_id` returns `invalid`, not `id_reused`, and leaves the stored receipt untouched.
   **Catches:** the wrong order of the two rules, and storing receipts for rejected input. The `it.each` next to it covers the limits of `base_revision`: `-1`, `1.5`, `"1"`, `true` and `NaN` are invalid, while `0` and an empty `text` are valid.

3. **Malformed items do not fail the batch.** `sync.e2e-spec.ts`: _"malformed items do not fail the batch: the DTO only checks the envelope"_.
   `[null, "text", <valid op>]` returns HTTP 200 with `[invalid, invalid, applied]`. A body without an array, with an unknown field, or with more than 1000 items returns 400, and nothing is applied.
   **Catches:** HTTP-level validation reaching into the items (for example `@ValidateNested`), which would reject the whole queue because of one bad operation.

**How I checked that the tests can fail.** I introduced three bugs by hand, one at a time: storing the receipt by reference, skipping the revision bump when the text is unchanged, and storing receipts only for applied operations. Each one made at least one test fail (1, 1 and 3 failures). The code was then restored.

---

## Decisions

### 1. Where to validate: DTO or domain?

**What I wanted to check.** The first controller cast the body by hand (`body as { operations?: unknown }`). The usual NestJS approach is a DTO with `ValidationPipe`, and it makes the contract explicit. But the challenge says an error must not stop the operations after it.

**How I investigated.** A DTO with `@ValidateNested` on each operation turns any bad item into a 400 for the entire request. That breaks the per-operation rule. Typing the items as `Operation[]` would also tell the compiler they were validated when they were not.

**Conclusion.** Split the contract in two layers. The DTO validates only the envelope: an array, at most 1000 items, no unknown fields. Items stay `unknown[]` and the domain validates them one by one. The pipe is bound on the route parameter rather than globally in `main.ts`, because the e2e tests don't run `main.ts` and would silently skip a global pipe. The e2e test in "Tests worth reading" #3 pins this down.

### 2. Should it have a database? (a suggestion from the AI, checked against the brief)

**What I wanted to check.** The role is senior, and adding Postgres felt like it might show more. The AI recommended against it.

**How I investigated.** I checked the challenge text: it explicitly says disk storage is not needed and asks for a small solution as a starting point for conversation. I also worked through what a database changes. Every read and write becomes `await`, and two requests could then both read revision 2 and both write revision 3.

**Conclusion.** Stay in memory, keep the domain behind repository ports, and explain the production design below instead of half-building it. The fix for the race is not a lock inside Node, which would break with more than one server instance. The fix is letting the database decide.

---

## Taking it to production

What would change, in order of importance:

- **Storage with the database as the arbiter.** One transaction per operation:
  ```sql
  INSERT INTO receipts (op_id, fingerprint, result) VALUES (...)
    ON CONFLICT (op_id) DO NOTHING;      -- duplicate op_id: read the stored receipt instead
  UPDATE notes SET text = $text, revision = revision + 1
    WHERE id = $id AND revision = $base; -- 0 rows affected = conflict
  ```
  This works with many server instances, because atomicity moves from Node's single thread to the database. The batch must still run sequentially (`for … of` with `await`, never `Promise.all`), because order matters. Only the two repository providers in `sync.module.ts` change. The `NotesRepository` and `ReceiptsRepository` interfaces would become async.
- **Authentication and ownership.** `op_id` scoped per user or device, and notes scoped per owner. Today any client can read every receipt.
- **Receipt retention.** Receipts grow forever. Keep them for a window longer than the longest offline period expected (a TTL), and document that very old retries will be treated as new operations.
- **Pushing changes.** Clients learn about other devices' edits only when they sync. A `GET /notes?since=<cursor>` endpoint, or a push channel, would avoid full pulls.
- **Observability.** Count conflicts, `id_reused` and invalid operations per client. A spike in `id_reused` points to a client bug.

## Limitations and what is not done

- In-memory only. Restarting the server loses everything, by design for this challenge.
- No deletion, automatic merge or real-time editing (out of scope in the challenge).
- In the simulator, a device sees other devices' edits only after it presses **Sync** (or reconnects).
- The simulator uses the note name as `note_id`. A real app would use generated ids and a separate title.
- The simulator has no automated tests; it was verified by running the demo scenario in Chrome, including the lost-response and same-note-created-twice cases.

---

## Use of AI

I used Claude (Claude Code) throughout: to understand the problem, discuss the design, write code and tests, and run checks.

**How it helped.** Before writing any code, it explained the protocol with an analogy and an interactive walkthrough. It sketched the data structures, proposed the domain/infra/Nest split, wrote most of the code and tests, and diagnosed the editor issue.

**What I changed or decided:**
- NestJS was my choice, because it is what I know best and I can read and explain it fluently.
- My first idea was CRUD routes for notes and operations, plus an interceptor for the checks. After discussing it, I dropped both. CRUD routes would let a note change without the revision check. A global pipe or interceptor would reject whole batches, and it would treat idempotency, which is a business rule here, as a transport concern.
- I kept a single `SyncModule` instead of my usual one-module-per-entity, to avoid circular dependencies between notes and receipts.
- I asked for the explicit DTO contract (decision 1), and for everything in English so that it matches the video.
- The multi-device simulator with separate storage was my idea. The AI implemented it.
- A pass-through `SyncService` that the AI first proposed was dropped, because it added nothing between the controllers and the engine.

**How I verified the AI's work:**
- I read the code and ran the tests.
- I used the hand-introduced bugs described above to check that the tests can actually fail.
- I ran the server and drove the simulator in a real browser, comparing the network log with the expected results.
- When the editor showed errors that the build did not, I traced them to VS Code's bundled TypeScript 6 (`baseUrl` deprecated, `types` defaulting to `[]`). The fix was confirmed by type-checking with both 5.9.3 and 6.0.3.
- Each commit in the history was built and tested on its own before being recorded.
