import { ValidationPipe } from '@nestjs/common';
import { ReceiptLookupDto } from './receipt-lookup.dto';

const parse = (value: unknown) =>
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }).transform(
    value,
    { type: 'body', metatype: ReceiptLookupDto },
  );

describe('ReceiptLookupDto', () => {
  it('accepts one opaque string id', async () => {
    await expect(parse({ op_ids: ['a'] })).resolves.toBeDefined();
  });

  it.each([
    {},
    { op_ids: 'a' },
    { op_ids: [12] },
    { op_ids: ['  '] },
    { op_ids: ['a'], extra: true },
    { op_ids: Array.from({ length: 1001 }, () => 'a') },
  ])('rejects an invalid request: %j', async (value) => {
    await expect(parse(value)).rejects.toThrow();
  });
});
