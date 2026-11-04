import { Operation } from './types';

export type ValidationResult =
  | { ok: true; op: Operation }
  | { ok: false; op_id: string | null; errors: string[] };

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Checks the shape of an incoming operation before any processing.
 * Input is `unknown` because it comes straight from the client.
 * Collects every error instead of stopping at the first one.
 */
export function validateOperation(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      op_id: null,
      errors: ['operation must be an object'],
    };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  if (!isNonEmptyString(raw.op_id)) {
    errors.push('op_id must be a non-empty string');
  }
  if (!isNonEmptyString(raw.note_id)) {
    errors.push('note_id must be a non-empty string');
  }
  // Number.isInteger rejects NaN, Infinity, 1.5, '1' and true.
  if (
    !Number.isInteger(raw.base_revision) ||
    (raw.base_revision as number) < 0
  ) {
    errors.push('base_revision must be an integer >= 0');
  }
  // Empty text is allowed: clearing a note is a legitimate edit.
  if (typeof raw.text !== 'string') {
    errors.push('text must be a string');
  }

  if (errors.length > 0) {
    return {
      ok: false,
      op_id: isNonEmptyString(raw.op_id) ? raw.op_id : null,
      errors,
    };
  }

  // Rebuild the object so unknown extra fields never reach storage.
  return {
    ok: true,
    op: {
      op_id: raw.op_id as string,
      note_id: raw.note_id as string,
      base_revision: raw.base_revision as number,
      text: raw.text as string,
    },
  };
}
