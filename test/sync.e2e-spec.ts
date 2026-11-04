import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Sync API (e2e)', () => {
  let app: INestApplication<App>;

  const sync = (operations: unknown) =>
    request(app.getHttpServer()).post('/sync').send({ operations });

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

  it('challenge example over HTTP: old receipt vs current query', async () => {
    const res = await sync([
      { op_id: 'O1', note_id: 'N', base_revision: 0, text: 'start' },
      { op_id: 'O2', note_id: 'N', base_revision: 1, text: 'edit A' },
      { op_id: 'O3', note_id: 'N', base_revision: 1, text: 'edit B' },
      { op_id: 'O2', note_id: 'N', base_revision: 1, text: 'edit A' },
      { op_id: 'O4', note_id: 'N', base_revision: 2, text: 'A + B' },
    ]).expect(200);

    const statuses = (
      res.body as { results: { status: string }[] }
    ).results.map((r) => r.status);
    expect(statuses).toEqual([
      'applied',
      'applied',
      'conflict',
      'applied',
      'applied',
    ]);

    const replay = await sync([
      { op_id: 'O3', note_id: 'N', base_revision: 1, text: 'edit B' },
    ]).expect(200);
    expect(replay.body).toMatchObject({
      results: [{ status: 'conflict', server_note: { revision: 2 } }],
    });

    await request(app.getHttpServer())
      .get('/notes/N')
      .expect(200, { id: 'N', text: 'A + B', revision: 3 });
  });

  it('an invalid operation in the batch is a result, not an HTTP error', async () => {
    const res = await sync([
      { op_id: 'a', note_id: 'N', base_revision: 'x', text: 'y' },
      { op_id: 'b', note_id: 'N', base_revision: 0, text: 'ok' },
    ]).expect(200);
    expect(res.body).toMatchObject({
      results: [{ status: 'invalid' }, { status: 'applied' }],
    });
  });

  it('envelope without an operations array is 400', async () => {
    await request(app.getHttpServer()).post('/sync').send({}).expect(400);
    await sync('not an array').expect(400);
  });

  it('GET /operations/:opId returns the stored receipt', async () => {
    await sync([{ op_id: 'a', note_id: 'N', base_revision: 0, text: 'x' }]);
    await request(app.getHttpServer())
      .get('/operations/a')
      .expect(200)
      .expect((r) => expect(r.body).toMatchObject({ status: 'applied' }));
    await request(app.getHttpServer()).get('/operations/zzz').expect(404);
  });

  it('GET /notes lists, GET /notes/:id for a missing note is 404', async () => {
    await sync([
      { op_id: 'a', note_id: 'N1', base_revision: 0, text: 'x' },
      { op_id: 'b', note_id: 'N2', base_revision: 0, text: 'y' },
    ]);
    const res = await request(app.getHttpServer()).get('/notes').expect(200);
    expect(res.body).toHaveLength(2);
    await request(app.getHttpServer()).get('/notes/missing').expect(404);
  });
});
