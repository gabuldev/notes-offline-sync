import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { SyncEngine } from './domain/sync-engine';
import type { OpResult } from './domain/types';
import { SyncRequestDto } from './dto/sync-request.dto';

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
  sync(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    body: SyncRequestDto,
  ): { results: OpResult[] } {
    return { results: this.engine.process(body.operations) };
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
