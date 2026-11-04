import { InMemoryNotesRepository } from '../infra/in-memory-notes.repository';
import { InMemoryReceiptsRepository } from '../infra/in-memory-receipts.repository';
import { SyncEngine } from './sync-engine';
import { Operation } from './types';

const op = (
  op_id: string,
  base_revision: number,
  text: string,
  note_id = 'N',
): Operation => ({ op_id, note_id, base_revision, text });

describe('SyncEngine', () => {
  let engine: SyncEngine;

  beforeEach(() => {
    engine = new SyncEngine(
      new InMemoryNotesRepository(),
      new InMemoryReceiptsRepository(),
    );
  });

  describe('challenge example', () => {
    it('replays O1, O2, O3, O2 resend, O4', () => {
      const [r1, r2, r3, r2again, r4] = engine.process([
        op('O1', 0, 'start'),
        op('O2', 1, 'edit A'),
        op('O3', 1, 'edit B'),
        op('O2', 1, 'edit A'),
        op('O4', 2, 'A + B'),
      ]);

      expect(r1).toEqual({
        op_id: 'O1',
        status: 'applied',
        note: { id: 'N', text: 'start', revision: 1 },
      });
      expect(r2).toEqual({
        op_id: 'O2',
        status: 'applied',
        note: { id: 'N', text: 'edit A', revision: 2 },
      });
      expect(r3).toEqual({
        op_id: 'O3',
        status: 'conflict',
        server_note: { id: 'N', text: 'edit A', revision: 2 },
        proposal: op('O3', 1, 'edit B'),
      });
      expect(r2again).toEqual(r2);
      expect(r4).toEqual({
        op_id: 'O4',
        status: 'applied',
        note: { id: 'N', text: 'A + B', revision: 3 },
      });

      // Resending O3 returns the original receipt (revision 2), but a query shows revision 3.
      const [r3again] = engine.process([op('O3', 1, 'edit B')]);
      expect(r3again).toEqual(r3);
      expect(engine.getNote('N')).toEqual({
        id: 'N',
        text: 'A + B',
        revision: 3,
      });

      // Reusing O2 with different text is an error.
      const [reused] = engine.process([op('O2', 1, 'other text')]);
      expect(reused).toEqual({ op_id: 'O2', status: 'id_reused' });
    });
  });

  describe('creation and revisions', () => {
    it('base 0 on a missing note creates it at revision 1', () => {
      const [r] = engine.process([op('a', 0, 'x')]);
      expect(r.status).toBe('applied');
      expect(engine.getNote('N')?.revision).toBe(1);
    });

    it('base 0 on an existing note is a conflict and does not overwrite', () => {
      engine.process([op('a', 0, 'original')]);
      const [r] = engine.process([op('b', 0, 'attempt')]);
      expect(r).toMatchObject({
        status: 'conflict',
        server_note: { text: 'original', revision: 1 },
        proposal: { text: 'attempt' },
      });
      expect(engine.getNote('N')?.text).toBe('original');
    });

    it('base > 0 on a missing note returns note_not_found with the proposal', () => {
      const [r] = engine.process([op('a', 3, 'x', 'GHOST')]);
      expect(r).toEqual({
        op_id: 'a',
        status: 'note_not_found',
        proposal: op('a', 3, 'x', 'GHOST'),
      });
      expect(engine.getNote('GHOST')).toBeUndefined();
    });

    it('base ahead of the current revision is also a conflict', () => {
      engine.process([op('a', 0, 'x')]);
      const [r] = engine.process([op('b', 5, 'y')]);
      expect(r.status).toBe('conflict');
      expect(engine.getNote('N')?.revision).toBe(1);
    });

    it('same text as current still bumps the revision', () => {
      engine.process([op('a', 0, 'same')]);
      const [r] = engine.process([op('b', 1, 'same')]);
      expect(r).toMatchObject({
        status: 'applied',
        note: { text: 'same', revision: 2 },
      });
    });

    it('different notes have independent revisions', () => {
      engine.process([op('a', 0, 'x', 'N1'), op('b', 0, 'y', 'N2')]);
      engine.process([op('c', 1, 'x2', 'N1')]);
      expect(engine.getNote('N1')?.revision).toBe(2);
      expect(engine.getNote('N2')?.revision).toBe(1);
    });

    it('resolves a conflict with a new op_id and the current base revision', () => {
      engine.process([op('a', 0, 'base'), op('b', 1, 'A')]);
      const [conflict] = engine.process([op('c', 1, 'B')]);
      expect(conflict.status).toBe('conflict');
      const current =
        conflict.status === 'conflict' ? conflict.server_note.revision : -1;
      const [resolved] = engine.process([op('d', current, 'A and B')]);
      expect(resolved).toMatchObject({
        status: 'applied',
        note: { text: 'A and B', revision: 3 },
      });
    });
  });

  describe('idempotency and receipts', () => {
    it('resend does not apply again: revision unchanged', () => {
      engine.process([op('a', 0, 'x'), op('b', 1, 'y')]);
      engine.process([op('b', 1, 'y'), op('b', 1, 'y')]);
      expect(engine.getNote('N')?.revision).toBe(2);
    });

    it('a conflict also claims the op_id: resend returns the same old conflict', () => {
      engine.process([op('a', 0, 'x'), op('b', 1, 'y')]);
      const [first] = engine.process([op('c', 1, 'z')]);
      engine.process([op('d', 2, 'w'), op('e', 3, 'v')]); // note moves on to rev 4
      const [again] = engine.process([op('c', 1, 'z')]);
      expect(again).toEqual(first);
      expect(again).toMatchObject({ server_note: { revision: 2 } });
    });

    it('note_not_found also claims the op_id', () => {
      engine.process([op('a', 2, 'x')]);
      const [reused] = engine.process([op('a', 2, 'other')]);
      expect(reused.status).toBe('id_reused');
    });

    it('same op_id with any field changed is id_reused', () => {
      engine.process([op('a', 0, 'x')]);
      const results = engine.process([
        op('a', 0, 'x', 'OTHER'),
        op('a', 1, 'x'),
        op('a', 0, 'y'),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        'id_reused',
        'id_reused',
        'id_reused',
      ]);
    });

    it('id_reused does not overwrite the original receipt', () => {
      const [original] = engine.process([op('a', 0, 'x')]);
      engine.process([op('a', 0, 'different')]);
      const [again] = engine.process([op('a', 0, 'x')]);
      expect(again).toEqual(original);
    });

    it('stored receipt is unaffected if the caller mutates the returned object', () => {
      const [r] = engine.process([op('a', 0, 'x')]);
      if (r.status === 'applied') r.note.text = 'tampered';
      const [again] = engine.process([op('a', 0, 'x')]);
      expect(again).toMatchObject({ note: { text: 'x' } });
      expect(engine.getNote('N')?.text).toBe('x');
    });

    it('same op_id twice in one batch is treated as a resend', () => {
      const results = engine.process([op('a', 0, 'x'), op('a', 0, 'x')]);
      expect(results[1]).toEqual(results[0]);
      expect(engine.getNote('N')?.revision).toBe(1);
    });

    it('getReceipt returns the stored receipt', () => {
      const [r] = engine.process([op('a', 0, 'x')]);
      expect(engine.getReceipt('a')).toEqual(r);
      expect(engine.getReceipt('never')).toBeUndefined();
    });
  });

  describe('validation', () => {
    it.each([
      [
        'blank op_id',
        { op_id: '  ', note_id: 'N', base_revision: 0, text: 'x' },
      ],
      ['missing op_id', { note_id: 'N', base_revision: 0, text: 'x' }],
      [
        'non-string note_id',
        { op_id: 'a', note_id: 7, base_revision: 0, text: 'x' },
      ],
      [
        'negative base',
        { op_id: 'a', note_id: 'N', base_revision: -1, text: 'x' },
      ],
      [
        'fractional base',
        { op_id: 'a', note_id: 'N', base_revision: 1.5, text: 'x' },
      ],
      [
        'base as string',
        { op_id: 'a', note_id: 'N', base_revision: '1', text: 'x' },
      ],
      [
        'boolean base',
        { op_id: 'a', note_id: 'N', base_revision: true, text: 'x' },
      ],
      ['base NaN', { op_id: 'a', note_id: 'N', base_revision: NaN, text: 'x' }],
      ['missing text', { op_id: 'a', note_id: 'N', base_revision: 0 }],
      ['text null', { op_id: 'a', note_id: 'N', base_revision: 0, text: null }],
      ['not an object', 'loose string'],
      ['null', null],
      ['array', []],
    ])('%s → invalid', (_label, input) => {
      const [r] = engine.process([input]);
      expect(r.status).toBe('invalid');
      expect(r.status === 'invalid' && r.errors.length).toBeGreaterThan(0);
    });

    it('reports every error at once', () => {
      const [r] = engine.process([{ op_id: '', base_revision: -1 }]);
      expect(r).toMatchObject({ status: 'invalid', op_id: null });
      expect(r.status === 'invalid' && r.errors).toHaveLength(4);
    });

    it('empty text is valid', () => {
      const [r] = engine.process([op('a', 0, '')]);
      expect(r).toMatchObject({ status: 'applied', note: { text: '' } });
    });

    it('an invalid operation does not claim the op_id: the same id works later', () => {
      const [bad] = engine.process([
        { op_id: 'a', note_id: 'N', base_revision: 'zero', text: 'x' },
      ]);
      expect(bad).toMatchObject({ status: 'invalid', op_id: 'a' });
      expect(engine.getReceipt('a')).toBeUndefined();

      const [good] = engine.process([op('a', 0, 'x')]);
      expect(good.status).toBe('applied');
    });

    it('validation runs before dedup: invalid op with a used op_id is invalid', () => {
      const [original] = engine.process([op('a', 0, 'x')]);
      const [bad] = engine.process([
        { op_id: 'a', note_id: 'N', base_revision: -1, text: 'x' },
      ]);
      expect(bad.status).toBe('invalid');
      expect(engine.getReceipt('a')).toEqual(original);
    });
  });

  describe('queue', () => {
    it('an error or conflict mid-queue does not block the rest, and order is kept', () => {
      const results = engine.process([
        op('a', 0, 'x'),
        { op_id: 'b', note_id: 'N', base_revision: 'bad', text: 'y' },
        op('c', 0, 'conflicts'),
        op('d', 1, 'continues'),
      ]);
      expect(results.map((r) => [r.op_id, r.status])).toEqual([
        ['a', 'applied'],
        ['b', 'invalid'],
        ['c', 'conflict'],
        ['d', 'applied'],
      ]);
      expect(engine.getNote('N')).toEqual({
        id: 'N',
        text: 'continues',
        revision: 2,
      });
    });

    it('empty queue returns an empty list', () => {
      expect(engine.process([])).toEqual([]);
    });
  });
});
