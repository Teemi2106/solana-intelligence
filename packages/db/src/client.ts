import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema/index";

export interface Database {
  readonly query: PostgresJsDatabase<typeof schema>;
  readonly sql: Sql;
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string, options: { maxConnections?: number; quiet?: boolean } = {}): Database {
  const client = postgres(databaseUrl, {
    max: options.maxConnections ?? 10,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    prepare: false,
    ...(options.quiet ? { onnotice: () => undefined } : {}),
  });
  return {
    query: drizzle(client, { schema }),
    sql: client,
    close: async () => client.end({ timeout: 5 }),
  };
}

export async function checkDatabase(database: Database): Promise<{ status: "up" | "down"; latencyMs: number }> {
  const started = performance.now();
  try {
    await database.sql`select 1`;
    return { status: "up", latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { status: "down", latencyMs: Math.round(performance.now() - started) };
  }
}
