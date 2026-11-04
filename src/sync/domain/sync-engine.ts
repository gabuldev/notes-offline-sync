import { NotesRepository, ReceiptsRepository } from './ports';
import { Note, OpResult, Operation } from './types';
import { validateOperation } from './validate';

/**
 * Identity of an operation's content. op_id is the key, so it is left out.
 * JSON of a fixed-order array is deterministic and unambiguous
 * (no separator can be forged inside a field).
 */
const fingerprint = (op: Operation): string =>
  JSON.stringify([op.note_id, op.base_revision, op.text]);

/**
 * Server-side sync rules. Pure TypeScript: no framework, no I/O.
 *
 * Each operation is handled as one synchronous step (read revision, compare,
 * write), so in Node's single thread no other operation can interleave.
 */
export class SyncEngine {
  constructor(
    private readonly notes: NotesRepository,
    private readonly receipts: ReceiptsRepository,
  ) {}

  /**
   * Processes the client's offline queue strictly in order, one operation at a
   * time, and returns one result per operation. Fully synchronous: each
   * operation finishes (read, compare, write) before the next one starts.
   */
  process(operations: unknown[]): OpResult[] {
    return operations.map((input) => this.processOne(input));
  }

  getNote(id: string): Note | undefined {
    return this.notes.get(id);
  }

  listNotes(): Note[] {
    return this.notes.list();
  }

  getReceipt(opId: string): OpResult | undefined {
    return this.receipts.get(opId)?.result;
  }

  private processOne(input: unknown): OpResult {
    // 1. Validate first: an invalid operation never touches the receipts.
    const validation = validateOperation(input);
    if (!validation.ok) {
      return {
        op_id: validation.op_id,
        status: 'invalid',
        errors: validation.errors,
      };
    }
    const op = validation.op;

    // 2. Idempotency: a known op_id is answered from the stored receipt.
    const stored = this.receipts.get(op.op_id);
    if (stored) {
      if (stored.fingerprint === fingerprint(op)) {
        return stored.result;
      }
      return { op_id: op.op_id, status: 'id_reused' };
    }

    // 3. First time we see this op_id: decide, then record the receipt.
    const result = this.decide(op);
    this.receipts.save(op.op_id, { fingerprint: fingerprint(op), result });
    return result;
  }

  private decide(op: Operation): OpResult {
    const current = this.notes.get(op.note_id);

    if (!current) {
      if (op.base_revision !== 0) {
        return { op_id: op.op_id, status: 'note_not_found', proposal: op };
      }
      const created: Note = { id: op.note_id, text: op.text, revision: 1 };
      this.notes.save(created);
      return { op_id: op.op_id, status: 'applied', note: created };
    }

    // Covers stale bases, bases from the future, and base 0 on an existing note.
    if (op.base_revision !== current.revision) {
      return {
        op_id: op.op_id,
        status: 'conflict',
        server_note: current,
        proposal: op,
      };
    }

    // Accepted even if the text is unchanged: every accepted write bumps the revision.
    const updated: Note = {
      id: current.id,
      text: op.text,
      revision: current.revision + 1,
    };
    this.notes.save(updated);
    return { op_id: op.op_id, status: 'applied', note: updated };
  }
}
