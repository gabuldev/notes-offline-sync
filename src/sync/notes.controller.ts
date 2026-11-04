import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { SyncEngine } from './domain/sync-engine';
import type { Note } from './domain/types';

/** Read-only on purpose: notes change only through POST /sync. */
@Controller('notes')
export class NotesController {
  constructor(private readonly engine: SyncEngine) {}

  @Get()
  list(): Note[] {
    return this.engine.listNotes();
  }

  @Get(':id')
  get(@Param('id') id: string): Note {
    const note = this.engine.getNote(id);
    if (!note) {
      throw new NotFoundException(`note "${id}" does not exist`);
    }
    return note;
  }
}
