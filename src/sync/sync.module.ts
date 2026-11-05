import { Module } from '@nestjs/common';
import { NotesRepository, ReceiptsRepository } from './domain/ports';
import { SyncEngine } from './domain/sync-engine';
import { InMemoryNotesRepository } from './infra/in-memory-notes.repository';
import { InMemoryReceiptsRepository } from './infra/in-memory-receipts.repository';
import { NotesController } from './notes.controller';
import { SyncController } from './sync.controller';
import { ReceiptLookupController } from './receipt-lookup.controller';
import { ReceiptLookupService } from './receipt-lookup.service';
import { NOTES_REPOSITORY, RECEIPTS_REPOSITORY } from './tokens';

/**
 * Single module on purpose: processing one operation touches notes and
 * receipts together, so splitting them would only add cross-module wiring.
 * Swapping storage means swapping the two repository providers below.
 */
@Module({
  controllers: [SyncController, NotesController, ReceiptLookupController],
  providers: [
    ReceiptLookupService,
    { provide: NOTES_REPOSITORY, useClass: InMemoryNotesRepository },
    { provide: RECEIPTS_REPOSITORY, useClass: InMemoryReceiptsRepository },
    {
      provide: SyncEngine,
      useFactory: (notes: NotesRepository, receipts: ReceiptsRepository) =>
        new SyncEngine(notes, receipts),
      inject: [NOTES_REPOSITORY, RECEIPTS_REPOSITORY],
    },
  ],
})
export class SyncModule {}
