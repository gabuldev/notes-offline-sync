import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { SyncEngine } from './domain/sync-engine';
import type { OpResult } from './domain/types';

@Controller()
export class SyncController {
  constructor(private readonly engine: SyncEngine) {}

  /**
   * Receives the client's offline queue. Only the envelope is checked here;
   * each operation is validated by the engine so that one bad operation
   * becomes an `invalid` result instead of rejecting the whole batch.
   */
  @Post('sync')
  @HttpCode(200)
  sync(@Body() body: unknown): { results: OpResult[] } {
    const operations = (body as { operations?: unknown } | null)?.operations;
    if (!Array.isArray(operations)) {
      throw new BadRequestException('body must be { "operations": [...] }');
    }
    return { results: this.engine.process(operations) };
  }

  @Get('operations/:opId')
  receipt(@Param('opId') opId: string): OpResult {
    const receipt = this.engine.getReceipt(opId);
    if (!receipt) {
      throw new NotFoundException(`no receipt for op_id "${opId}"`);
    }
    return receipt;
  }
}
