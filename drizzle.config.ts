import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config for the simulator's own better-sqlite3 database.
 *
 * The schema is owned by the store builder at src/store/schema.ts. Migrations are
 * emitted to drizzle/ and applied with `pnpm db:migrate`. This file is read only by
 * the drizzle-kit CLI (loaded via esbuild), never by the app runtime, so reading
 * DB_PATH from the environment here is safe.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DB_PATH ?? './data/workday.db',
  },
  strict: true,
  verbose: true,
});
