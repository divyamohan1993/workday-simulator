/**
 * Process entry point.
 *
 * Responsibilities, and nothing else: load and validate configuration exactly once,
 * build the server, bind the listen socket, prove liveness with a real health probe
 * over the loopback interface, and install signal handlers that close the app
 * gracefully (draining the active run, the receiver, NATS and the database via the
 * onClose hook) with a hard timeout so a stuck teardown can never hang a container.
 *
 * A misconfiguration is fatal and loud: `loadConfig` throws `ConfigError`, which is
 * printed and the process exits non-zero before anything is constructed. No logger
 * exists yet at that point, so the message goes straight to stderr.
 */

import { request as undiciRequest } from 'undici';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from '../config/schema.js';
import { buildServer } from './build-server.js';

/** Hard cap on graceful shutdown before the process is forced to exit. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Timeout for the post-listen health self-probe. */
const PROBE_TIMEOUT_MS = 5_000;

/** Write a line to stderr without violating the no-console rule (no logger yet). */
function stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Probe `GET /api/health` over loopback to confirm the socket is actually accepting
 * connections and the app answers, not just that `listen` resolved.
 */
async function healthSelfProbe(port: number, log: FastifyInstance['log']): Promise<void> {
  const response = await undiciRequest(`http://127.0.0.1:${port}/api/health`, {
    method: 'GET',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  await response.body.dump();
  if (response.statusCode !== 200) {
    throw new Error(`health self-probe returned HTTP ${response.statusCode}`);
  }
  log.info({ httpStatus: response.statusCode }, 'health self-probe ok');
}

/** Close the app within a bounded time, then exit with `code`. */
async function shutdown(app: FastifyInstance, reason: string, code: number): Promise<void> {
  app.log.info({ reason }, 'graceful shutdown starting');
  const forceTimer = setTimeout(() => {
    app.log.error('graceful shutdown timed out; forcing exit');
    process.exit(code === 0 ? 1 : code);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();
  try {
    await app.close();
    clearTimeout(forceTimer);
    app.log.info('graceful shutdown complete');
    process.exit(code);
  } catch (err) {
    clearTimeout(forceTimer);
    app.log.error({ err }, 'error during graceful shutdown');
    process.exit(code === 0 ? 1 : code);
  }
}

/** Boot the server: config, build, listen, probe, signal handlers. */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = await buildServer(config);

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error({ err }, 'failed to bind listen socket');
    await app.close().catch(() => undefined);
    process.exit(1);
    return;
  }

  try {
    await healthSelfProbe(config.PORT, app.log);
  } catch (err) {
    app.log.error({ err }, 'health self-probe failed; shutting down');
    await shutdown(app, 'self-probe failed', 1);
    return;
  }

  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown(app, signal, 0);
  };
  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));

  app.log.info({ port: config.PORT, host: config.HOST }, 'workday simulator listening');
}

main().catch((err: unknown) => {
  stderr(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
