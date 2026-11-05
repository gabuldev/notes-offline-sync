import { Injectable } from '@nestjs/common';
import { SyncEngine } from './domain/sync-engine';
import { OpResult } from './domain/types';

export type LookupResult =
  | { op_id: string; status: 'found'; receipt: OpResult }
  | { op_id: string; status: 'not_found' };

@Injectable()
export class ReceiptLookupService {
  constructor(private readonly engine: SyncEngine) {}

  lookup(opIds: string[]): LookupResult[] {
    // Normalize keys and perform one lookup for each distinct pending operation.
    const ids = [...new Set(opIds.map((id) => id.trim()))];
    return ids.map((op_id) => {
      const stored = this.engine.getReceipt(op_id);
      if (!stored) return { op_id, status: 'not_found' };

      // Include the latest note when it is available for the reconnecting client.
      let receipt = stored;
      if (stored.status === 'applied') {
        receipt = {
          ...stored,
          note: this.engine.getNote(stored.note.id) ?? stored.note,
        };
      } else if (stored.status === 'conflict') {
        receipt = {
          ...stored,
          server_note:
            this.engine.getNote(stored.server_note.id) ?? stored.server_note,
        };
      }
      return { op_id, status: 'found', receipt };
    });
  }
}
