import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import {
  correlationId,
  createLogger,
  REDACT_CENSOR,
  withCorrelationId,
} from './logger.js';

/** A sync pino destination that captures each emitted JSON line. */
function capture(): { dest: DestinationStream; last: () => Record<string, unknown> } {
  const lines: string[] = [];
  const dest: DestinationStream = {
    write(chunk: string): void {
      lines.push(chunk);
    },
  };
  return {
    dest,
    last: () => JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>,
  };
}

describe('createLogger redaction', () => {
  it('scrubs secrets at every realistic nesting while keeping benign fields', () => {
    const sink = capture();
    const logger = createLogger({ level: 'info' }, sink.dest);

    logger.info(
      {
        token: 'TOP',
        password: 'PW',
        auth: { token: 'A_TOK', password: 'A_PW', clientSecret: 'A_CS', secret: 'A_SEC', kind: 'bearer' },
        target: { auth: { token: 'T_TOK', clientSecret: 'T_CS' }, name: 'oneim' },
        req: { headers: { authorization: 'Bearer xyz', 'content-type': 'application/json' } },
        headers: { authorization: 'Bearer abc' },
        keep: 'visible',
      },
      'delivery target configured',
    );

    const rec = sink.last();
    const auth = rec.auth as Record<string, unknown>;
    const target = rec.target as Record<string, unknown>;
    const targetAuth = target.auth as Record<string, unknown>;
    const reqHeaders = (rec.req as { headers: Record<string, unknown> }).headers;
    const headers = rec.headers as Record<string, unknown>;

    expect(rec.token).toBe(REDACT_CENSOR);
    expect(rec.password).toBe(REDACT_CENSOR);
    expect(auth.token).toBe(REDACT_CENSOR);
    expect(auth.password).toBe(REDACT_CENSOR);
    expect(auth.clientSecret).toBe(REDACT_CENSOR);
    expect(auth.secret).toBe(REDACT_CENSOR);
    expect(targetAuth.token).toBe(REDACT_CENSOR);
    expect(targetAuth.clientSecret).toBe(REDACT_CENSOR);
    expect(reqHeaders.authorization).toBe(REDACT_CENSOR);
    expect(headers.authorization).toBe(REDACT_CENSOR);

    // Non-secret fields are untouched.
    expect(auth.kind).toBe('bearer');
    expect(target.name).toBe('oneim');
    expect(reqHeaders['content-type']).toBe('application/json');
    expect(rec.keep).toBe('visible');
  });

  it('respects the configured level', () => {
    const sink = capture();
    const logger = createLogger({ level: 'warn' }, sink.dest);
    logger.info('suppressed');
    logger.warn('emitted');
    expect(sink.last().msg).toBe('emitted');
  });
});

describe('correlation ids', () => {
  it('generates distinct non-empty ids', () => {
    const a = correlationId();
    const b = correlationId();
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
  });

  it('stamps a correlation id onto every child record', () => {
    const sink = capture();
    const logger = createLogger({ level: 'info' }, sink.dest);
    withCorrelationId(logger, 'corr-123').info('scoped');
    expect(sink.last().correlationId).toBe('corr-123');
  });
});
