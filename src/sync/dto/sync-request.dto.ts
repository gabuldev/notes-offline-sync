import { ArrayMaxSize, IsArray } from 'class-validator';

export const MAX_OPERATIONS_PER_SYNC = 1000;

/**
 * Body of POST /sync: { "operations": [...] }.
 *
 * Only the envelope is validated here. Each item is expected to look like an
 * `Operation` ({ op_id, note_id, base_revision, text }), but it stays `unknown`
 * on purpose: items are validated one by one by the domain, so a malformed
 * operation becomes an `invalid` result instead of a 400 for the whole batch.
 */
export class SyncRequestDto {
  @IsArray({ message: 'operations must be an array' })
  @ArrayMaxSize(MAX_OPERATIONS_PER_SYNC, {
    message: `operations accepts at most ${MAX_OPERATIONS_PER_SYNC} items`,
  })
  operations!: unknown[];
}
