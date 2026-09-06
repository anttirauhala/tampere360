import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLogger,
  getCorrelationId,
  newCorrelationId,
  serializeError,
  withCorrelationId,
} from './logger';

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kirjoittaa JSON-rivin perustasoilla', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ service: 'test-service', environment: 'dev' });

    logger.info('hei maailma', { avain: 'arvo' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['level']).toBe('INFO');
    expect(parsed['service']).toBe('test-service');
    expect(parsed['environment']).toBe('dev');
    expect(parsed['message']).toBe('hei maailma');
    expect(parsed['avain']).toBe('arvo');
    expect(typeof parsed['timestamp']).toBe('string');
  });

  it('kunnioittaa minLevel-asetusta', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger({ service: 'test', minLevel: 'WARN' });

    logger.debug('ei näy');
    logger.info('ei näy');
    logger.warn('näkyy');

    // DEBUG ja INFO suodatetaan pois; WARN kirjoitetaan console.warniin
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]?.[0] as string;
    expect((JSON.parse(line) as { message?: string }).message).toBe('näkyy');
  });

  it('ERROR-taso käyttää console.erroria', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger({ service: 'test' });

    logger.error('virhe', { error: serializeError(new Error('kaatui')) });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line) as { error?: { message?: string } };
    expect(parsed.error?.message).toBe('kaatui');
  });

  it('child-loggeri perii ja lisää kenttiä', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ service: 'test', baseFields: { base: 1 } });
    const child = logger.child({ source: 'FMI_CAP' });

    child.info('lapsi');

    const line = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['base']).toBe(1);
    expect(parsed['source']).toBe('FMI_CAP');
  });
});

describe('correlation ID', () => {
  it('kulkee AsyncLocalStorage-kontekstissa', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ service: 'test' });
    const correlationId = newCorrelationId();

    withCorrelationId(correlationId, () => {
      expect(getCorrelationId()).toBe(correlationId);
      logger.info('kontekstissa');
    });

    const line = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['correlationId']).toBe(correlationId);

    // Kontekstin ulkopuolella correlationId ei ole asetettu
    expect(getCorrelationId()).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('newCorrelationId tuottaa UUID-muotoisen tunnisteen', () => {
    expect(newCorrelationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
