import { NotesRepository } from '../domain/ports';
import { Note } from '../domain/types';

/** In-memory store that copies on write and on read, like a real database would. */
export class InMemoryNotesRepository implements NotesRepository {
  private readonly notes = new Map<string, Note>();

  get(id: string): Note | undefined {
    const note = this.notes.get(id);
    return note && structuredClone(note);
  }

  save(note: Note): void {
    this.notes.set(note.id, structuredClone(note));
  }

  list(): Note[] {
    return [...this.notes.values()].map((n) => structuredClone(n));
  }
}
