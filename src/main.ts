import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Device simulator (plain HTML/JS) served from /public on the same origin as the API.
  app.useStaticAssets(join(__dirname, '..', 'public'));
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`API and device simulator on http://localhost:${port}`);
}
void bootstrap();
