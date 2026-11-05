import './load-env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureViews } from './views.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  try {
    app.enableShutdownHooks();
    await configureViews(app);
    await app.listen(process.env.PORT ?? 3000);
  } catch (error) {
    await app.close();
    throw error;
  }
}
bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
