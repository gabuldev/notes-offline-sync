import { Controller, Get } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * Liveness check. `instance_id` changes on every restart, which tells
 * clients that the in-memory state they synced against is gone.
 */
@Controller('health')
export class HealthController {
  private readonly instanceId = randomUUID();
  private readonly startedAt = new Date().toISOString();

  @Get()
  check(): { status: 'ok'; instance_id: string; started_at: string } {
    return {
      status: 'ok',
      instance_id: this.instanceId,
      started_at: this.startedAt,
    };
  }
}
