import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('POST /operations/lookup', () => {
  let app: INestApplication<App>;
  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns an existing receipt and an unknown id with HTTP 200', async () => {
    const synced = await request(app.getHttpServer())
      .post('/sync')
      .send({
        operations: [{ op_id: 'A', note_id: 'N', base_revision: 0, text: 'x' }],
      })
      .expect(200);
    const results = (synced.body as { results: unknown[] }).results;
    await request(app.getHttpServer())
      .post('/operations/lookup')
      .send({ op_ids: ['A', 'missing'] })
      .expect(200, {
        results: [
          { op_id: 'A', status: 'found', receipt: results[0] },
          { op_id: 'missing', status: 'not_found' },
        ],
      });
    await request(app.getHttpServer())
      .get('/notes/N')
      .expect(200, { id: 'N', text: 'x', revision: 1 });
  });

  it('keeps the envelope validation on the real route', async () => {
    await request(app.getHttpServer())
      .post('/operations/lookup')
      .send({ op_ids: ['A'], unknown: true })
      .expect(400);
    await request(app.getHttpServer()).get('/operations/A').expect(404);
  });
});
