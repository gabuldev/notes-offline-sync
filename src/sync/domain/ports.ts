import { Note, StoredReceipt } from './types';

/**
 * Storage contracts the domain depends on. Implementations must behave like a
 * real database: store and return copies, never shared references.
 */
export interface NotesRepository {
  get(id: string): Note | undefined;
  save(note: Note): void;
  list(): Note[];
}

export interface ReceiptsRepository {
  get(opId: string): StoredReceipt | undefined;
  save(opId: string, receipt: StoredReceipt): void;
}
