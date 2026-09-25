import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client";

const databaseUrl = process.env["DATABASE_URL"];

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const database = createDatabase(databaseUrl, { maxConnections: 1 });

try {
  await migrate(database.query, { migrationsFolder: "drizzle" });
} finally {
  await database.close();
}
