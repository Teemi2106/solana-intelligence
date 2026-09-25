import "server-only";
import { createDatabase } from "@swi/db";
import { getServerConfig } from "./server-config";

const globalDatabase = globalThis as typeof globalThis & { __swiDatabase?: ReturnType<typeof createDatabase> };

export function getDatabase() {
  globalDatabase.__swiDatabase ??= createDatabase(getServerConfig().DATABASE_URL, { maxConnections: 5 });
  return globalDatabase.__swiDatabase;
}
