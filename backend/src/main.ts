import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureViews } from './views.config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

async function bootstrap() {
  const envPath = join(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureViews(app);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
