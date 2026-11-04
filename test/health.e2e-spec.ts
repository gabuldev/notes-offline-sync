import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const boot = async (): Promise<INestApplication<App>> => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();
  return app;
};

const instanceOf = async (app: INestApplication<App>): Promise<string> => {
  const res = await request(app.getHttpServer()).get('/health').expect(200);
  return (res.body as { instance_id: string }).instance_id;
};

describe('GET /health (e2e)', () => {
  it('is stable within one run and changes after a restart', async () => {
    const first = await boot();
    const id = await instanceOf(first);
    expect(await instanceOf(first)).toBe(id);
    await first.close();

    const second = await boot();
    expect(await instanceOf(second)).not.toBe(id);
    await second.close();
  });
});
