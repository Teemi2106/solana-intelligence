import { afterAll, describe, expect, it } from "vitest";
import { schema } from "@swi/db";
import { createTestDatabase, requireDatabase } from "@swi/db/testing";
import { behaviorOrderingKey, buildHistoricalBehaviorBaseline, evaluateWalletBehavior, repairHistoricalBehaviorOrderingKeys } from "./behavior-anomaly.js";

const context = await createTestDatabase();
afterAll(async () => context?.dispose());

const POLICY = { recentDays: 30, longTermDays: 180, maxObservations: 2_000, incidentWindowMinutes: 30 };
const NOW = new Date("2026-09-29T15:22:59.353Z");

describe.skipIf(!context)("behavior baseline PostgreSQL integration", () => {
  it("persists real snapshots, reports actual inserts, stays idempotent, and never creates alerts", async () => {
    const database = requireDatabase(context);
    const [wallet] = await database.query.insert(schema.trackedWallets).values({ address: "BehaviorIntegrationWallet111111111111111111111" }).returning();
    const [token] = await database.query.insert(schema.tokens).values({ mint: "BehaviorIntegrationMint11111111111111111111111", decimals: 6 }).returning();
    const [event] = await database.query.insert(schema.providerEvents).values({ provider: "test", externalEventId: "behavior-integration", payloadHash: "hash", eventType: "HISTORICAL_TRANSACTION", status: "PROCESSED", payloadSummary: {} }).returning();
    if (!wallet || !token || !event) throw new Error("BEHAVIOR_FIXTURE_SETUP_FAILED");

    const occurredAt = new Date("2026-09-01T12:34:56.789Z");
    const [transaction] = await database.query.insert(schema.walletTransactions).values({ walletId: wallet.id, providerEventId: event.id, signature: "behavior-signature", instructionIndex: 0, kind: "SWAP", slot: 448_896_046n, occurredAt, finality: "finalized", succeeded: true, normalizedPayload: {} }).returning();
    if (!transaction) throw new Error("BEHAVIOR_TRANSACTION_SETUP_FAILED");
    await database.query.insert(schema.walletTrades).values({ walletId: wallet.id, transactionId: transaction.id, tokenId: token.id, side: "BUY", rawTokenAmount: "1000000", tokenDecimals: 6, rawBaseAmount: "1250000000", baseDecimals: 9, baseMint: "So11111111111111111111111111111111111111112", venue: "TEST_DEX", quality: "HIGH", occurredAt });
    await database.query.insert(schema.walletEconomicActions).values({ walletId: wallet.id, transactionId: transaction.id, actionIndex: 2, action: "BUY", tokenId: token.id, rawTokenAmount: "1000000", tokenDecimals: 6, confidence: "HIGH", evidence: [], providerType: "UNKNOWN", classificationVersion: "test", occurredAt });

    const first = await buildHistoricalBehaviorBaseline(database, wallet.id, POLICY, NOW);
    expect(first).toMatchObject({ observations: 3, baselines: 4, diagnostics: {
      historyComplete: false, includedObservationCount: 2, selectedObservationCount: 2,
      excludedByLongTermWindow: 0, removedByPerFeatureCap: 0, groupCount: 2,
      attemptedSnapshotCount: 4, persistedSnapshotCount: 4,
    } });
    expect([...first.diagnostics.groups].sort((a, b) => a.featureKind.localeCompare(b.featureKind))).toEqual([
      { featureKind: "POSITION_SIZE_SOL", unit: "SOL", selected: 1, recent: 1, long: 1 },
      { featureKind: "VENUE_NOVELTY", unit: "CATEGORY", selected: 1, recent: 1, long: 1 },
    ]);

    const baselines = await database.sql<{ quality: string }[]>`select quality from wallet_behavior_baselines where wallet_id=${wallet.id}`;
    expect(baselines).toHaveLength(4);
    expect(new Set(baselines.map((row) => row.quality))).toEqual(new Set(["INSUFFICIENT"]));

    const [boundary] = await database.sql<{ ordering_key: string }[]>`select ordering_key from wallet_behavior_observations where wallet_id=${wallet.id} and feature_kind='ACTION_BOUNDARY'`;
    expect(boundary?.ordering_key).toBe(behaviorOrderingKey({ occurred_at: occurredAt, slot: 448_896_046n, signature: "behavior-signature", action_index: 2 }));

    const rerun = await buildHistoricalBehaviorBaseline(database, wallet.id, POLICY, NOW);
    expect(rerun).toMatchObject({ observations: 0, baselines: 0, diagnostics: { includedObservationCount: 2, selectedObservationCount: 2, attemptedSnapshotCount: 4, persistedSnapshotCount: 0 } });
    const [safety] = await database.sql<{ anomalies: number; incidents: number; notifications: number }[]>`select (select count(*)::int from wallet_anomalies where wallet_id=${wallet.id}) anomalies,(select count(*)::int from wallet_behavior_incidents where wallet_id=${wallet.id}) incidents,(select count(*)::int from wallet_anomaly_notifications n join wallet_behavior_incidents i on i.id=n.incident_id where i.wallet_id=${wallet.id}) notifications`;
    expect(safety).toEqual({ anomalies: 0, incidents: 0, notifications: 0 });

    const lateAt = new Date("2026-09-01T12:34:55.999Z");
    const [lateTransaction] = await database.query.insert(schema.walletTransactions).values({ walletId: wallet.id, providerEventId: event.id, signature: "late-signature", instructionIndex: 0, kind: "TRANSFER", slot: 448_896_045n, occurredAt: lateAt, finality: "finalized", succeeded: true, normalizedPayload: {} }).returning();
    if (!lateTransaction) throw new Error("LATE_TRANSACTION_SETUP_FAILED");
    await database.query.insert(schema.walletEconomicActions).values({ walletId: wallet.id, transactionId: lateTransaction.id, actionIndex: 0, action: "TRANSFER_IN", confidence: "HIGH", evidence: [], providerType: "UNKNOWN", classificationVersion: "test", occurredAt: lateAt });
    const repaired = await evaluateWalletBehavior(database, wallet.id, POLICY, undefined, NOW);
    expect(repaired.evaluated).toBe(2);
    const [state] = await database.sql<{ evaluation_generation: number; watermark_ordering_key: string; dirty_from_ordering_key: string | null }[]>`select evaluation_generation,watermark_ordering_key,dirty_from_ordering_key from wallet_behavior_state where wallet_id=${wallet.id}`;
    expect(state).toMatchObject({ evaluation_generation: 2, watermark_ordering_key: behaviorOrderingKey({ occurred_at: occurredAt, slot: 448_896_046n, signature: "behavior-signature", action_index: 2 }), dirty_from_ordering_key: null });
  });

  it("renders byte-identical UTC keys in different PostgreSQL session time zones", async () => {
    const database = requireDatabase(context);
    const timestamp = new Date("2026-09-29T15:22:59.353Z");
    const expected = behaviorOrderingKey({ occurred_at: timestamp, slot: 448_896_046n, signature: "signature", action_index: 7 });
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      const actual = await database.sql.begin(async (sql) => {
        await sql.unsafe(`set local time zone '${zone}'`);
        const [row] = await sql<{ key: string }[]>`select to_char(${timestamp.toISOString()}::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||'|'||lpad(${"448896046"}::text,20,'0')||'|'||${"signature"}||'|'||lpad(${"7"}::text,3,'0') key`;
        return row?.key;
      });
      expect(actual).toBe(expected);
    }
  });

  it("orders equal timestamps by slot, signature, then action index", () => {
    const occurred_at = new Date("2026-09-29T15:22:59.353Z");
    const rows = [
      { occurred_at, slot: 2n, signature: "b", action_index: 0 },
      { occurred_at, slot: 1n, signature: "z", action_index: 0 },
      { occurred_at, slot: 2n, signature: "a", action_index: 2 },
      { occurred_at, slot: 2n, signature: "a", action_index: 1 },
    ];
    expect(rows.map(behaviorOrderingKey).sort()).toEqual([
      behaviorOrderingKey({ occurred_at, slot: 1n, signature: "z", action_index: 0 }),
      behaviorOrderingKey({ occurred_at, slot: 2n, signature: "a", action_index: 1 }),
      behaviorOrderingKey({ occurred_at, slot: 2n, signature: "a", action_index: 2 }),
      behaviorOrderingKey({ occurred_at, slot: 2n, signature: "b", action_index: 0 }),
    ]);
  });

  it("repairs old keys atomically from authoritative fields and rejects canonical collisions", async () => {
    const database = requireDatabase(context);
    const [wallet] = await database.query.insert(schema.trackedWallets).values({ address: "BehaviorRepairWallet111111111111111111111111" }).returning();
    const [event] = await database.query.insert(schema.providerEvents).values({ provider: "test", externalEventId: "behavior-repair", payloadHash: "hash", eventType: "HISTORICAL_TRANSACTION", status: "PROCESSED", payloadSummary: {} }).returning();
    if (!wallet || !event) throw new Error("REPAIR_FIXTURE_SETUP_FAILED");
    const occurredAt = new Date("2026-09-02T03:04:05.678Z");
    const [transaction] = await database.query.insert(schema.walletTransactions).values({ walletId: wallet.id, providerEventId: event.id, signature: "repair-signature", instructionIndex: 0, kind: "TRANSFER", slot: 448_896_100n, occurredAt, finality: "finalized", succeeded: true, normalizedPayload: {} }).returning();
    if (!transaction) throw new Error("REPAIR_TRANSACTION_SETUP_FAILED");
    const [action] = await database.query.insert(schema.walletEconomicActions).values({ walletId: wallet.id, transactionId: transaction.id, actionIndex: 3, action: "TRANSFER_IN", confidence: "HIGH", evidence: [], providerType: "UNKNOWN", classificationVersion: "test", occurredAt }).returning();
    if (!action) throw new Error("REPAIR_ACTION_SETUP_FAILED");
    const oldKey = "2026-09-02 03:04:05.678+00|00000000000448896100|repair-signature|003";
    const expected = behaviorOrderingKey({ occurred_at: occurredAt, slot: 448_896_100n, signature: "repair-signature", action_index: 3 });
    await database.sql`insert into wallet_behavior_observations(wallet_id,transaction_id,action_id,source_type,source_id,feature_kind,family,categorical_value,unit,occurred_at,ordering_key,quality,methodology_version,evidence,included_in_baseline) values(${wallet.id},${transaction.id},${action.id},'HISTORICAL_ACTION_BOUNDARY',${action.id},'ACTION_BOUNDARY','SEQUENCE','BASELINE_SEEDED','MARKER',${occurredAt.toISOString()}::timestamptz,${oldKey},'HIGH','behavior-v1','{}'::jsonb,false)`;
    await database.sql`insert into wallet_behavior_state(wallet_id,watermark_ordering_key,history_status,history_complete,methodology_version) values(${wallet.id},${oldKey},'COMPLETED',false,'behavior-v1')`;
    await database.sql`insert into wallet_behavior_baselines(wallet_id,feature_kind,cohort,window_start,window_end,through_ordering_key,observation_count,coverage_days,quality,history_complete,completeness_bps,statistics,methodology_version,evaluation_generation,generated_at) values(${wallet.id},'VENUE_NOVELTY','CATEGORY:LONG','2026-08-01T00:00:00Z','2026-09-03T00:00:00Z',${oldKey},1,1,'INSUFFICIENT',false,0,'{}'::jsonb,'behavior-v1',1,'2026-09-03T00:00:00Z')`;

    const before = await database.sql<{ count: number; sources: number }[]>`select count(*)::int count,count(distinct source_id)::int sources from wallet_behavior_observations where wallet_id=${wallet.id}`;
    expect(await repairHistoricalBehaviorOrderingKeys(database, wallet.id)).toEqual({ observations: 1, baselines: 1, watermark: expected });
    const [after] = await database.sql<{ count: number; sources: number; mixed: number; key: string; watermark: string; through_key: string }[]>`select count(*)::int count,count(distinct o.source_id)::int sources,count(*) filter(where o.ordering_key not like '%T%.%Z|%')::int mixed,min(o.ordering_key) key,min(s.watermark_ordering_key) watermark,min(b.through_ordering_key) through_key from wallet_behavior_observations o join wallet_behavior_state s on s.wallet_id=o.wallet_id join wallet_behavior_baselines b on b.wallet_id=o.wallet_id where o.wallet_id=${wallet.id}`;
    expect(after).toMatchObject({ ...before[0], mixed: 0, key: expected, watermark: expected, through_key: expected });
    const [safety] = await database.sql<{ anomalies: number; incidents: number; notifications: number }[]>`select (select count(*)::int from wallet_anomalies where wallet_id=${wallet.id}) anomalies,(select count(*)::int from wallet_behavior_incidents where wallet_id=${wallet.id}) incidents,(select count(*)::int from wallet_anomaly_notifications n join wallet_behavior_incidents i on i.id=n.incident_id where i.wallet_id=${wallet.id}) notifications`;
    expect(safety).toEqual({ anomalies: 0, incidents: 0, notifications: 0 });

    await database.sql`update wallet_behavior_observations set ordering_key=${oldKey} where wallet_id=${wallet.id}`;
    await database.sql`update wallet_behavior_state set watermark_ordering_key=${oldKey} where wallet_id=${wallet.id}`;
    await database.sql`update wallet_behavior_baselines set through_ordering_key=${oldKey} where wallet_id=${wallet.id}`;
    await database.sql.unsafe("create function fail_behavior_repair_for_test() returns trigger language plpgsql as $$ begin raise exception 'SIMULATED_BEHAVIOR_REPAIR_FAILURE'; end $$");
    await database.sql.unsafe("create trigger fail_behavior_repair_for_test before update on wallet_behavior_state for each row execute function fail_behavior_repair_for_test() ");
    await expect(repairHistoricalBehaviorOrderingKeys(database, wallet.id)).rejects.toThrow("SIMULATED_BEHAVIOR_REPAIR_FAILURE");
    await database.sql.unsafe("drop trigger fail_behavior_repair_for_test on wallet_behavior_state");
    await database.sql.unsafe("drop function fail_behavior_repair_for_test()");
    const [rolledBack] = await database.sql<{ key: string; watermark: string; through_key: string }[]>`select min(o.ordering_key) key,min(s.watermark_ordering_key) watermark,min(b.through_ordering_key) through_key from wallet_behavior_observations o join wallet_behavior_state s on s.wallet_id=o.wallet_id join wallet_behavior_baselines b on b.wallet_id=o.wallet_id where o.wallet_id=${wallet.id}`;
    expect(rolledBack).toEqual({ key: oldKey, watermark: oldKey, through_key: oldKey });

    const [collisionWallet] = await database.query.insert(schema.trackedWallets).values({ address: "BehaviorCollisionWallet111111111111111111111" }).returning();
    if (!collisionWallet) throw new Error("COLLISION_WALLET_SETUP_FAILED");
    await database.sql`insert into wallet_behavior_state(wallet_id,history_status,history_complete,methodology_version) values(${collisionWallet.id},'COMPLETED',false,'behavior-v1')`;
    for (const instructionIndex of [0, 1]) {
      const [collisionTransaction] = await database.query.insert(schema.walletTransactions).values({ walletId: collisionWallet.id, providerEventId: event.id, signature: "collision-signature", instructionIndex, kind: "TRANSFER", slot: 448_896_200n, occurredAt, finality: "finalized", succeeded: true, normalizedPayload: {} }).returning();
      if (!collisionTransaction) throw new Error("COLLISION_TRANSACTION_SETUP_FAILED");
      await database.sql`insert into wallet_behavior_observations(wallet_id,transaction_id,source_type,source_id,feature_kind,family,categorical_value,unit,occurred_at,ordering_key,quality,methodology_version,evidence,included_in_baseline) values(${collisionWallet.id},${collisionTransaction.id},'PHASE2_HISTORICAL_DERIVATION',${collisionTransaction.id},'VENUE_NOVELTY','VENUE_ROUTE','TEST','CATEGORY',${occurredAt.toISOString()}::timestamptz,${`old-key-${String(instructionIndex)}`},'HIGH','behavior-v1','{}'::jsonb,true)`;
    }
    await expect(repairHistoricalBehaviorOrderingKeys(database, collisionWallet.id)).rejects.toThrow("BEHAVIOR_ORDERING_KEY_COLLISION");
    const collisionKeys = await database.sql<{ ordering_key: string }[]>`select ordering_key from wallet_behavior_observations where wallet_id=${collisionWallet.id} order by ordering_key`;
    expect(collisionKeys.map((row) => row.ordering_key)).toEqual(["old-key-0", "old-key-1"]);
  });
});
