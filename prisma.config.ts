/**
 * Prisma 7 CLI configuration — the connection URL for `prisma db push` /
 * `migrate` lives here (v7 removed `url` from the schema datasource block).
 * The runtime client gets its connection via the pg driver adapter in
 * src/db.ts; this file only serves the CLI.
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // Omitted when DATABASE_URL is unset so `prisma generate` (which needs no
  // database) works on a fresh checkout; db push / migrate fail with a clear
  // missing-datasource error instead of a config-load crash.
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
