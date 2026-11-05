import { SyncEngine } from './domain/sync-engine';
import { InMemoryNotesRepository } from './infra/in-memory-notes.repository';
import { InMemoryReceiptsRepository } from './infra/in-memory-receipts.repository';
import { ReceiptLookupService } from './receipt-lookup.service';

const setup = () => {
  const engine = new SyncEngine(
    new InMemoryNotesRepository(),
    new InMemoryReceiptsRepository(),
  );
  return { engine, lookup: new ReceiptLookupService(engine) };
};

describe('ReceiptLookupService', () => {
  it('looks up known and missing ids in input order', () => {
    const { engine, lookup } = setup();
    const [first] = engine.process([
      { op_id: 'B', note_id: 'N', base_revision: 0, text: 'x' },
    ]);
    expect(lookup.lookup(['missing', 'B'])).toEqual([
      { op_id: 'missing', status: 'not_found' },
      { op_id: 'B', status: 'found', receipt: first },
    ]);
  });

  it('does not reserve an id when lookup finds no receipt', () => {
    const { engine, lookup } = setup();
    expect(lookup.lookup(['new'])).toEqual([
      { op_id: 'new', status: 'not_found' },
    ]);
    expect(
      engine.process([
        { op_id: 'new', note_id: 'N', base_revision: 0, text: '' },
      ])[0].status,
    ).toBe('applied');
  });

  it('does not expose a mutable reference into the stored receipt', () => {
    const { engine, lookup } = setup();
    engine.process([{ op_id: 'A', note_id: 'N', base_revision: 0, text: 'x' }]);
    const [result] = lookup.lookup(['A']);
    if (result.status === 'found' && result.receipt.status === 'applied') {
      result.receipt.note.text = 'tampered';
    }
    expect(engine.getReceipt('A')).toMatchObject({ note: { text: 'x' } });
    expect(engine.getNote('N')?.text).toBe('x');
  });
});
