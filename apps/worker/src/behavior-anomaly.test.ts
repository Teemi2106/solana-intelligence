import { describe, expect, it } from "vitest";
import { behaviorOrderingKey, buildHistoricalBehaviorBaseline, canonicalBehaviorTimestamp } from "./behavior-anomaly.js";

const WALLET_ID = "145cfb1a-65e5-49db-b61c-22328db4b834";
const POLICY = { recentDays: 30, longTermDays: 180, maxObservations: 2_000, incidentWindowMinutes: 30 };

function baselineDatabase(options: { failBaseline?: boolean } = {}) {
  const calls: { text: string; parameters: unknown[] }[] = [];
  let committed = false;
  const transaction = Object.assign(
    (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      const text = strings.join("?");
      calls.push({ text, parameters });
      if (text.includes("select exists(select 1 from wallet_ingestion_runs")) return Promise.resolve([{ complete: true }]);
      if (text.includes("select count(*)::int count")) return Promise.resolve([{ count: 0 }]);
      if (text.includes("ordering_key from wallet_economic_actions")) return Promise.resolve([{ ordering_key: "2026-09-01T00:00:00.000Z|00000000000000000001|sig|000" }]);
      if (text.includes("count(*)::int included")) return Promise.resolve([{ included: 1, within_window: 1 }]);
      if (text.includes("select feature_kind,unit,numeric_value::text")) return Promise.resolve([{
        feature_kind: "POSITION_SIZE_SOL", unit: "SOL", numeric_value: "1.25", categorical_value: null,
        occurred_at: new Date("2026-09-01T00:00:00.000Z"),
      }]);
      if (text.includes("select history_complete from wallet_behavior_state")) return Promise.resolve([{ history_complete: true }]);
      if (text.includes("insert into wallet_behavior_baselines") && options.failBaseline === true) return Promise.reject(new Error("SIMULATED_BASELINE_FAILURE"));
      if (text.includes("insert into wallet_behavior_baselines")) return Promise.resolve([{ id: "baseline-id" }]);
      return Promise.resolve([]);
    },
    { json: (value: unknown) => value },
  );
  const sql = Object.assign(transaction, {
    begin: async (_options: string, work: (tx: typeof transaction) => Promise<unknown>) => {
      try {
        const result = await work(transaction);
        committed = true;
        return result;
      } catch (error) {
        committed = false;
        throw error;
      }
    },
  });
  return { database: { sql } as never, calls, committed: () => committed };
}

describe("behavior timestamp canonicalization", () => {
  it("reproduces the rejected raw Date boundary and supplies stable UTF-8 text", () => {
    const occurredAt = new Date("2026-09-29T10:22:59.353-05:00");

    expect(() => Buffer.byteLength(occurredAt as never)).toThrow(/string.*Date/is);
    const canonical = canonicalBehaviorTimestamp(occurredAt);

    expect(canonical).toBe("2026-09-29T15:22:59.353Z");
    expect(() => Buffer.byteLength(canonical)).not.toThrow();
    expect(canonical).not.toContain("[object Object]");
    expect(canonical).not.toBe(occurredAt.toString());
  });

  it("creates deterministic locale-independent ordering identities from DB-shaped Date rows", () => {
    const row = {
      occurred_at: new Date("2026-09-29T15:22:59.353Z"),
      slot: 448_896_046n,
      signature: "signature",
      action_index: 2,
    };
    const expected = "2026-09-29T15:22:59.353Z|00000000000448896046|signature|002";

    expect(behaviorOrderingKey(row)).toBe(expected);
    expect(behaviorOrderingKey({ ...row, occurred_at: new Date(row.occurred_at.getTime()) })).toBe(expected);
  });

  it("rejects invalid timestamps instead of silently stringifying them", () => {
    expect(() => canonicalBehaviorTimestamp(new Date(Number.NaN))).toThrow("INVALID_BEHAVIOR_TIMESTAMP");
  });

  it("accepts DB-shaped Date rows and sends only canonical strings to baseline timestamp parameters", async () => {
    const first = baselineDatabase();
    const second = baselineDatabase();
    const now = new Date("2026-09-29T15:22:59.353Z");

    await expect(buildHistoricalBehaviorBaseline(first.database, WALLET_ID, POLICY, now)).resolves.toMatchObject({ baselines: 2 });
    await expect(buildHistoricalBehaviorBaseline(second.database, WALLET_ID, POLICY, new Date(now.getTime()))).resolves.toEqual(
      await buildHistoricalBehaviorBaseline(baselineDatabase().database, WALLET_ID, POLICY, new Date(now.getTime())),
    );

    const baselineCalls = first.calls.filter((call) => call.text.includes("insert into wallet_behavior_baselines"));
    expect(baselineCalls).toHaveLength(2);
    for (const call of baselineCalls) {
      expect(call.parameters.filter((parameter) => parameter instanceof Date)).toEqual([]);
      expect(call.parameters).toContain("2026-09-29T15:22:59.353Z");
    }
    expect(first.calls.some((call) => call.text.includes("wallet_anomaly_notifications"))).toBe(false);
    expect(first.committed()).toBe(true);
  });

  it("keeps the transaction uncommitted when baseline persistence fails", async () => {
    const fixture = baselineDatabase({ failBaseline: true });
    await expect(buildHistoricalBehaviorBaseline(fixture.database, WALLET_ID, POLICY, new Date("2026-09-29T15:22:59.353Z"))).rejects.toThrow("SIMULATED_BASELINE_FAILURE");
    expect(fixture.committed()).toBe(false);
  });
});
