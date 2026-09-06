/**
 * Jäsennelty JSON-logitus Lambda-ympäristöön.
 * Jokainen lokirivi on yksi JSON-objekti (CloudWatch Logs -yhteensopiva).
 * Correlation ID kulkee AsyncLocalStorage:n läpi koko käsittelyketjussa.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export interface CorrelationContext {
  correlationId: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Suorita funktio correlation ID -kontekstissa. */
export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** Nykyinen correlation ID (jos konteksti on aktiivinen). */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Generoi uuden correlation ID:n (UUID v4). */
export function newCorrelationId(): string {
  return randomUUID();
}

export interface LoggerOptions {
  /** Palvelun/Paketin nimi, esim. "ingest-fmi" tai "normalizer". */
  service: string;
  /** Ympäristö: dev | test | prod. */
  environment?: string;
  /** Lähdejärjestelmä lähdekohtaisille logeille. */
  source?: string;
  /** Vähimmäistaso (oletus INFO; LOG_LEVEL-ympäristömuuttuja ohittaa). */
  minLevel?: LogLevel;
  /** Lisäkentät jokaiselle riville. */
  baseFields?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Lapsiloggeri perii kentät ja lisää omiaan. */
  child(bindings: Record<string, unknown>): Logger;
}

function isValidLevel(value: string | undefined): value is LogLevel {
  return value === 'DEBUG' || value === 'INFO' || value === 'WARN' || value === 'ERROR';
}

/** Serialisoi virheen lokiriville. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: String(error) };
}

/** Luo jäsennellyn loggerin. */
export function createLogger(options: LoggerOptions): Logger {
  const envLevel = process.env['LOG_LEVEL'];
  const minLevel: LogLevel = options.minLevel ?? (isValidLevel(envLevel) ? envLevel : 'INFO');

  function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      service: options.service,
      message,
      ...(options.baseFields ?? {}),
      ...(fields ?? {}),
    };
    if (options.environment) entry['environment'] = options.environment;
    if (options.source) entry['source'] = options.source;

    const correlationId = getCorrelationId();
    if (correlationId) entry['correlationId'] = correlationId;

    const line = JSON.stringify(entry);
    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (message, fields) => write('DEBUG', message, fields),
    info: (message, fields) => write('INFO', message, fields),
    warn: (message, fields) => write('WARN', message, fields),
    error: (message, fields) => write('ERROR', message, fields),
    child: (bindings) =>
      createLogger({
        ...options,
        minLevel,
        baseFields: { ...(options.baseFields ?? {}), ...bindings },
      }),
  };
}
