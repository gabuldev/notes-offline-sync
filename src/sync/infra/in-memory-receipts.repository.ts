import { ReceiptsRepository } from '../domain/ports';
import { StoredReceipt } from '../domain/types';

/**
 * Copies on write and on read, so a stored receipt can never change after the
 * fact, no matter what the caller does with the object it receives.
 */
export class InMemoryReceiptsRepository implements ReceiptsRepository {
  private readonly receipts = new Map<string, StoredReceipt>();

  get(opId: string): StoredReceipt | undefined {
    const receipt = this.receipts.get(opId);
    return receipt && structuredClone(receipt);
  }

  save(opId: string, receipt: StoredReceipt): void {
    this.receipts.set(opId, structuredClone(receipt));
  }
}
