export interface Note {
  id: string;
  text: string;
  revision: number;
}

export interface Operation {
  op_id: string;
  note_id: string;
  base_revision: number;
  text: string;
}

export type OpResult =
  | { op_id: string; status: 'applied'; note: Note }
  | {
      op_id: string;
      status: 'conflict';
      server_note: Note;
      proposal: Operation;
    }
  | { op_id: string; status: 'note_not_found'; proposal: Operation }
  | { op_id: string; status: 'id_reused' }
  | { op_id: string | null; status: 'invalid'; errors: string[] };

export type OpStatus = OpResult['status'];

/** What the server keeps per accepted op_id: the content fingerprint and the original receipt. */
export interface StoredReceipt {
  fingerprint: string;
  result: OpResult;
}
