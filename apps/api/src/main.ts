import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@seedingsys/config';
import { initObservability } from '@seedingsys/observability';
import { AppModule } from './app.module';

async function main() {
  const cfg = loadConfig();
  initObservability('api', cfg.SENTRY_DSN, cfg.APP_ENV);
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableShutdownHooks();
  await app.listen(cfg.API_PORT);
  console.log(`api listening on :${cfg.API_PORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
