import pino, { type Logger } from 'pino';
import * as Sentry from '@sentry/node';

export type { Logger };

/** JSON logger. Always log job_id / publication_id / target_id as bindings, never secrets. */
export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    name,
    level,
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: ['*.apiKey', '*.cookie', '*.cookies', '*.password', '*.token', 'headers.authorization'], censor: '[redacted]' },
  });
}

let sentryOn = false;

/** Sentry (v8+) ships its own OpenTelemetry setup, so traces and errors share one pipeline. */
export function initObservability(service: string, dsn?: string, environment?: string) {
  if (!dsn || sentryOn) return;
  Sentry.init({ dsn, environment, serverName: service, tracesSampleRate: 0.2 });
  sentryOn = true;
}

export function captureError(err: unknown, context?: Record<string, unknown>) {
  if (!sentryOn) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export async function withSpan<T>(name: string, attrs: Record<string, string | number>, fn: () => Promise<T>): Promise<T> {
  if (!sentryOn) return fn();
  return Sentry.startSpan({ name, attributes: attrs }, fn);
}
