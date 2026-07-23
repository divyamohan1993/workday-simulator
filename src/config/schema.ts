import { z } from 'zod';

/**
 * Environment and runtime configuration.
 *
 * Contract rules that bind every builder:
 * - `loadConfig(env)` is STARTUP-ONLY. No module may call it (or read a config
 *   singleton) at import top-level, or every unit test that imports that module
 *   would crash when ADMIN_TOKEN is absent. Inject the resolved config through
 *   constructors and factory functions instead.
 * - Configuration is validated once, at boot, and a misconfiguration crashes the
 *   process with a readable message rather than starting in a bad state.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Coerce an empty or whitespace-only string to `undefined` so that an unset
 * optional env var and one explicitly set to '' behave identically.
 *
 * WHY: `.optional()` only accepts `undefined`; an empty string is a PRESENT value
 * and still runs the inner check, so `RECEIVER_TOKEN=` (min 8) and `NATS_URL=`
 * (url) would fail validation and crash the process. Both documented deploy paths
 * emit exactly that empty string: `.env.example` ships `RECEIVER_TOKEN=`/`NATS_URL=`,
 * and Docker's `--env-file` and compose's `${VAR:-}` both interpolate a bare `KEY=`
 * to `''` inside the container. Preprocessing '' to undefined makes an empty optional
 * behave like an unset one, so the happy-path deploy boots instead of crash-looping.
 */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export const configSchema = z.object({
  /** Runtime mode. */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** HTTP listen address. */
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8477),

  /** better-sqlite3 database file for the simulator's own state. */
  DB_PATH: z.string().min(1).default('./data/workday.db'),

  /**
   * Bearer token guarding every /api route except /api/health, and the WebSocket
   * telemetry channel. Required; must be reasonably strong.
   */
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters'),

  /**
   * Token the built-in receiver requires on its SCIM/ingest endpoints. Optional;
   * when unset (or set to an empty string) the server reuses ADMIN_TOKEN for the
   * built-in target and receiver.
   */
  RECEIVER_TOKEN: z.preprocess(emptyToUndefined, z.string().min(8).optional()),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  /** Default delivery kind when a target does not specify one. */
  DEFAULT_TARGET_KIND: z.enum(['scim', 'webhook', 'rest', 'nats', 'batch']).default('scim'),

  /** Optional NATS server URL. When set, the nats delivery kind and NATS ingest
   *  on the built-in receiver become available. An empty string counts as unset. */
  NATS_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

  /** Default simulated seconds per real second (a scenario may override). */
  WORKDAY_ACCEL: z.coerce.number().positive().max(86_400).default(60),

  /** Global hard ceiling on generated events/second across all scenarios. */
  MAX_RPS: z.coerce.number().int().min(1).max(1_000_000).default(2_000),

  /** Deterministic seed for the identity pool and generators. */
  SEED: z.string().min(1).default('db-workday-2026'),

  /** Number of identities to seed into the simulated workforce. */
  IDENTITY_POOL_SIZE: z.coerce.number().int().min(1).max(1_000_000).default(20_000),

  /** How often to emit a telemetry frame over the WebSocket, in milliseconds. */
  METRICS_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),

  /** Size of the recent-events ring buffer carried in each telemetry frame. */
  TELEMETRY_RECENT_EVENTS: z.coerce.number().int().min(0).max(1_000).default(50),

  /** Directory of the built web dashboard, served as static assets. */
  WEB_DIST_PATH: z.string().min(1).default('./dist/web'),

  /** Comma-separated allowed CORS origins. Empty means same-origin only. */
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((raw) =>
      raw
        ? raw
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean)
        : [],
    ),
});

/** Fully-resolved, validated application configuration. */
export type AppConfig = z.infer<typeof configSchema>;

/** Thrown when configuration fails validation, carrying a human-readable report. */
export class ConfigError extends Error {
  public readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Parse and validate configuration from an environment map (defaults to
 * process.env). Throws ConfigError on any problem so the entrypoint can log and
 * exit non-zero. Never mutates the input.
 *
 * @param env The environment source. Pass an explicit object in tests.
 * @returns The validated, typed configuration.
 * @throws ConfigError when validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(issues);
  }
  return result.data;
}
