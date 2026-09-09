/**
 * The one pino logger. Fastify gets handed this same instance so HTTP logs and
 * agent-loop logs interleave in one stream with one format.
 *
 * pino-pretty is loaded as a transport only outside production — in production
 * the process writes newline-delimited JSON to stdout and the host ships it.
 */
import pino, { type Logger } from 'pino';
import type { Config } from '../config';

let instance: Logger | undefined;

export function createLogger(cfg: Pick<Config, 'logLevel' | 'nodeEnv'>): Logger {
  const pretty =
    cfg.nodeEnv !== 'production'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } } }
      : {};
  return pino({ level: cfg.logLevel, ...pretty });
}

/** Process-wide logger. `setLogger` is called once from index.ts at boot. */
export function setLogger(l: Logger): void {
  instance = l;
}

export function log(): Logger {
  if (!instance) {
    // A module that logs before boot (e.g. a config error) still gets a usable
    // logger rather than a crash-on-crash. Silent under jest so unit tests that
    // exercise retry/backoff paths do not spray warn lines into the report.
    instance = pino({ level: process.env.JEST_WORKER_ID ? 'silent' : process.env.LOG_LEVEL ?? 'info' });
  }
  return instance;
}
