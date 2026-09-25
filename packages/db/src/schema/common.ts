import { bigint, integer, jsonb, numeric, timestamp, uuid } from "drizzle-orm/pg-core";

export const id = () => uuid("id").defaultRandom().primaryKey();
export const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
export const observedAt = (name = "observed_at") => timestamp(name, { withTimezone: true }).notNull();
export const rawAmount = (name: string) => numeric(name, { precision: 78, scale: 0 });
export const usdAmount = (name: string) => numeric(name, { precision: 38, scale: 18 });
export const priceQuote = (name: string) => numeric(name, { precision: 60, scale: 30 });
export const ratio = (name: string) => numeric(name, { precision: 20, scale: 10 });
export const score = (name: string) => integer(name);
export const slot = (name = "slot") => bigint(name, { mode: "bigint" });
export const evidence = (name = "evidence") => jsonb(name).$type<readonly Record<string, unknown>[]>();
