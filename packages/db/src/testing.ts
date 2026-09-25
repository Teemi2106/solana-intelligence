import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDatabase, type Database } from "./client";

export interface TestDatabase {
  readonly database: Database;
  dispose(): Promise<void>;
}

/**
 * Creates a throwaway PostgreSQL database with all migrations applied, so idempotency and constraint behaviour are
 * tested against the real schema. Returns null when no server is reachable (tests then skip, e.g. on machines without the
 * docker-compose Postgres). Override the server with TEST_DATABASE_ADMIN_URL.
 */
export async function createTestDatabase(): Promise<TestDatabase | null> {
  const adminUrl = process.env["TEST_DATABASE_ADMIN_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:5433/postgres";
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 2, prepare: false, onnotice: () => undefined });
  const name = `swi_test_${randomBytes(6).toString("hex")}`;
  try {
    await admin.unsafe(`create database ${name}`);
  } catch {
    await admin.end({ timeout: 1 }).catch(() => undefined);
    return null;
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString(), { maxConnections: 8, quiet: true });
  await migrate(database.query, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  return {
    database,
    dispose: async () => {
      await database.close().catch(() => undefined);
      await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
      await admin.end({ timeout: 1 }).catch(() => undefined);
    },
  };
}

/** Narrows the optional test database inside suites that are skipped when it is unavailable. */
export function requireDatabase(context: TestDatabase | null): Database {
  if (!context) throw new Error("TEST_DATABASE_UNAVAILABLE");
  return context.database;
}
