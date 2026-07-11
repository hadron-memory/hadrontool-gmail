/**
 * Prisma client singleton for the tool's own database.
 *
 * Prisma 7: the engine-less client gets its connection through the pg driver
 * adapter (the CLI reads the URL from prisma.config.ts instead).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });

export const db = new PrismaClient({ adapter });
export type Db = PrismaClient;
