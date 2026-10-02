import { Decimal } from "decimal.js";
import { BEHAVIOR_POLICY_VERSION, FIFO_ACCOUNTING_METHODOLOGY_VERSION, HOLDING_DURATION_SOURCE_TYPE, actionNgrams, baselineQuality, classifyCategoricalDeviation, classifyNumericDeviation, deriveIncidentSeverity, empiricalPercentile, holdingDurationSemanticSourceId, numericStatistics, type AnomalyFamily, type AnomalySeverity, type BaselineQuality, type BehaviorDeviationDirection, type BehaviorEvaluationMode, type BehaviorFeatureKind } from "@swi/domain";
import type { Database, DatabaseTransactionSql } from "@swi/db";
import type { MetricsRegistry } from "@swi/observability";
import type { NotificationProvider } from "@swi/domain";

type TxSql = DatabaseTransactionSql;
type EvidenceValue = string | number | boolean | null;
interface BehaviorPolicy { recentDays: number; longTermDays: number; maxObservations: number; incidentWindowMinutes: number; }
interface Observation { featureKind: BehaviorFeatureKind; family: AnomalyFamily; numericValue?: string; categoricalValue?: string; unit: string; evidence: Record<string, EvidenceValue>; tokenId?: string | null; realization?: { semanticSourceId:string; sellTradeId:string; acquisitionTradeId:string; realizedRawAmount:string; accountingMethodologyVersion:string }; }
interface BaselineGroupDiagnostic { featureKind: BehaviorFeatureKind; unit: string; selected: number; recent: number; long: number; }
interface BaselineBuildDiagnostics {
  methodologyVersion: string;
  policy: Pick<BehaviorPolicy, "recentDays" | "longTermDays" | "maxObservations">;
  historicalBoundary: string | null;
  historyComplete: boolean;
  includedObservationCount: number;
  selectedObservationCount: number;
  excludedByLongTermWindow: number;
  removedByPerFeatureCap: number;
  groupCount: number;
  groups: readonly BaselineGroupDiagnostic[];
  attemptedSnapshotCount: number;
  persistedSnapshotCount: number;
}
const CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export function canonicalBehaviorTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("INVALID_BEHAVIOR_TIMESTAMP");
  return value.toISOString();
}

function parsedBehaviorTimestamp(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("INVALID_BEHAVIOR_TIMESTAMP");
  return parsed;
}

export const behaviorOrderingKey = (row: { occurred_at: Date; slot: bigint; signature: string; action_index: number }) => `${canonicalBehaviorTimestamp(row.occurred_at)}|${row.slot.toString().padStart(20, "0")}|${row.signature}|${String(row.action_index).padStart(3, "0")}`;

/** Explicitly invoked repair primitive; it is not called by worker startup, migrations, or baseline construction. */
export async function repairHistoricalBehaviorOrderingKeys(database: Database, walletId: string): Promise<{ observations: number; baselines: number; watermark: string | null }> {
  return database.sql.begin("isolation level repeatable read", async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${walletId}, 0))`;
    const [collision] = await sql<{ ordering_key: string }[]>`
      with candidates as (
        select o.transaction_id,coalesce(a.action_index,0) action_index,
          to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(coalesce(a.action_index,0)::text,3,'0') ordering_key
        from wallet_behavior_observations o join wallet_transactions wt on wt.id=o.transaction_id left join wallet_economic_actions a on a.id=o.action_id
        where o.wallet_id=${walletId} and o.source_type in ('PHASE2_HISTORICAL_DERIVATION',${HOLDING_DURATION_SOURCE_TYPE},'HISTORICAL_ACTION_BOUNDARY')
      )
      select ordering_key from candidates group by ordering_key having count(distinct (transaction_id,action_index))>1 limit 1`;
    if (collision) throw new Error("BEHAVIOR_ORDERING_KEY_COLLISION");

    const rewritten = await sql<{ id: string }[]>`
      update wallet_behavior_observations o set ordering_key=
        to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(coalesce((select a.action_index from wallet_economic_actions a where a.id=o.action_id),0)::text,3,'0')
      from wallet_transactions wt
      where o.wallet_id=${walletId} and o.transaction_id=wt.id and o.source_type in ('PHASE2_HISTORICAL_DERIVATION',${HOLDING_DURATION_SOURCE_TYPE},'HISTORICAL_ACTION_BOUNDARY')
        and o.ordering_key<>to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(coalesce((select a.action_index from wallet_economic_actions a where a.id=o.action_id),0)::text,3,'0')
      returning o.id`;

    const rewrittenBaselines = await sql<{ id: string }[]>`
      update wallet_behavior_baselines b set through_ordering_key=
        to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(a.action_index::text,3,'0')
      from wallet_economic_actions a join wallet_transactions wt on wt.id=a.transaction_id
      where b.wallet_id=${walletId} and a.wallet_id=${walletId}
        and b.through_ordering_key=wt.occurred_at::text||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(a.action_index::text,3,'0')
      returning b.id`;

    const [boundary] = await sql<{ ordering_key: string }[]>`select to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(a.action_index::text,3,'0') ordering_key from wallet_economic_actions a join wallet_transactions wt on wt.id=a.transaction_id where a.wallet_id=${walletId} and wt.finality='finalized' order by a.occurred_at desc,wt.slot desc,wt.signature desc,a.action_index desc limit 1`;
    await sql`update wallet_behavior_state set watermark_ordering_key=${boundary?.ordering_key??null},dirty_from_ordering_key=null,updated_at=now() where wallet_id=${walletId}`;
    const [mixed] = await sql<{ count: number }[]>`select count(*)::int count from wallet_behavior_observations where wallet_id=${walletId} and source_type in ('PHASE2_HISTORICAL_DERIVATION',${HOLDING_DURATION_SOURCE_TYPE},'HISTORICAL_ACTION_BOUNDARY') and ordering_key !~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\|'`;
    if ((mixed?.count??0)>0) throw new Error("BEHAVIOR_ORDERING_KEY_REPAIR_INCOMPLETE");
    return { observations: rewritten.length, baselines: rewrittenBaselines.length, watermark: boundary?.ordering_key??null };
  });
}

export async function buildHistoricalBehaviorBaseline(database: Database, walletId: string, policy: BehaviorPolicy, now = new Date()): Promise<{ observations: number; baselines: number; diagnostics: BaselineBuildDiagnostics }> {
  return database.sql.begin("isolation level repeatable read", async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${walletId}, 0))`;
    // Ordering repair and FIFO provenance reconciliation deliberately share this transaction: ordering is
    // transaction-level, while realization provenance is allocation-level.
    const [collision] = await sql<{ ordering_key:string }[]>`
      with candidates as (select o.transaction_id,coalesce(a.action_index,0) action_index,to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(coalesce(a.action_index,0)::text,3,'0') ordering_key from wallet_behavior_observations o join wallet_transactions wt on wt.id=o.transaction_id left join wallet_economic_actions a on a.id=o.action_id where o.wallet_id=${walletId} and o.source_type in ('PHASE2_HISTORICAL_DERIVATION',${HOLDING_DURATION_SOURCE_TYPE},'HISTORICAL_ACTION_BOUNDARY'))
      select ordering_key from candidates group by ordering_key having count(distinct (transaction_id,action_index))>1 limit 1`;
    if(collision)throw new Error("BEHAVIOR_ORDERING_KEY_COLLISION");
    await sql`update wallet_behavior_observations o set ordering_key=to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(coalesce((select a.action_index from wallet_economic_actions a where a.id=o.action_id),0)::text,3,'0') from wallet_transactions wt where o.wallet_id=${walletId} and o.transaction_id=wt.id and o.source_type in ('PHASE2_HISTORICAL_DERIVATION',${HOLDING_DURATION_SOURCE_TYPE},'HISTORICAL_ACTION_BOUNDARY') and o.ordering_key<>to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(coalesce((select a.action_index from wallet_economic_actions a where a.id=o.action_id),0)::text,3,'0')`;
    const [history] = await sql<{ complete: boolean }[]>`select exists(select 1 from wallet_ingestion_runs where wallet_id=${walletId} and status='COMPLETED') as complete`;
    await sql`insert into wallet_behavior_state(wallet_id,history_status,history_complete,methodology_version,updated_at) values(${walletId},'BUILDING',${history?.complete ?? false},${BEHAVIOR_POLICY_VERSION},now()) on conflict(wallet_id) do update set history_status='BUILDING',history_complete=excluded.history_complete,methodology_version=excluded.methodology_version,updated_at=now()`;
    const before = await countObservations(sql, walletId);
    await sql`
      insert into wallet_behavior_observations(wallet_id,transaction_id,action_id,token_id,source_type,source_id,feature_kind,family,numeric_value,unit,occurred_at,ordering_key,quality,methodology_version,evidence,included_in_baseline)
      select t.wallet_id,t.transaction_id,null,t.token_id,'PHASE2_HISTORICAL_DERIVATION',t.id::text,
        case when t.base_mint='So11111111111111111111111111111111111111112' then 'POSITION_SIZE_SOL' else 'POSITION_SIZE_USD' end,'SIZE',
        case when t.base_mint='So11111111111111111111111111111111111111112' and t.raw_base_amount is not null then t.raw_base_amount/1000000000::numeric else t.estimated_usd_value end,
        case when t.base_mint='So11111111111111111111111111111111111111112' then 'SOL' else 'USD' end,t.occurred_at,
        to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|000',t.quality,${BEHAVIOR_POLICY_VERSION},jsonb_build_object('tradeId',t.id,'provenance','PHASE2_HISTORICAL_DERIVATION'),true
      from wallet_trades t join wallet_transactions wt on wt.id=t.transaction_id
      where t.wallet_id=${walletId} and wt.finality='finalized' and t.side='BUY' and ((t.base_mint='So11111111111111111111111111111111111111112' and t.raw_base_amount is not null) or t.estimated_usd_value is not null)
      on conflict do nothing`;
    // Reconcile only this historical feature/methodology. Realization and lot UUIDs are rebuild-local;
    // sell/acquisition trades plus the exact FIFO allocation are durable semantic provenance.
    await sql`
      delete from wallet_behavior_observations o
      where o.wallet_id=${walletId} and o.feature_kind='HOLDING_DURATION' and o.methodology_version=${BEHAVIOR_POLICY_VERSION}
        and o.source_type in ('PHASE2_HISTORICAL_DERIVATION',${HOLDING_DURATION_SOURCE_TYPE})
        and not exists (
          select 1 from wallet_realizations r join wallet_inventory_lots l on l.id=r.lot_id
          where r.wallet_id=o.wallet_id and r.holding_seconds is not null
            and not exists(select 1 from jsonb_array_elements_text(r.issues) x where x.value in ('UNKNOWN_COST_BASIS','MISSING_SALE_PRICE'))
            and ${FIFO_ACCOUNTING_METHODOLOGY_VERSION}::text||'|wallet='||r.wallet_id::text||'|token='||r.token_id::text||'|sell='||r.sell_trade_id::text||'|acquisition='||l.source_trade_id::text||'|raw='||r.raw_amount::text=o.source_id
        )`;
    await sql`
      insert into wallet_behavior_observations(wallet_id,transaction_id,action_id,token_id,source_type,source_id,feature_kind,family,sell_trade_id,acquisition_trade_id,realized_raw_amount,accounting_methodology_version,numeric_value,unit,occurred_at,ordering_key,quality,methodology_version,evidence,included_in_baseline)
      select r.wallet_id,st.transaction_id,null,r.token_id,${HOLDING_DURATION_SOURCE_TYPE}::text,
        ${FIFO_ACCOUNTING_METHODOLOGY_VERSION}::text||'|wallet='||r.wallet_id::text||'|token='||r.token_id::text||'|sell='||r.sell_trade_id::text||'|acquisition='||l.source_trade_id::text||'|raw='||r.raw_amount::text,
        'HOLDING_DURATION','DURATION',r.sell_trade_id,l.source_trade_id,r.raw_amount,${FIFO_ACCOUNTING_METHODOLOGY_VERSION}::text,r.holding_seconds,'SECONDS',r.realized_at,
        to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|000',r.quality,${BEHAVIOR_POLICY_VERSION},
        jsonb_build_object('semanticRealizationId',${FIFO_ACCOUNTING_METHODOLOGY_VERSION}::text||'|wallet='||r.wallet_id::text||'|token='||r.token_id::text||'|sell='||r.sell_trade_id::text||'|acquisition='||l.source_trade_id::text||'|raw='||r.raw_amount::text,'sellTradeId',r.sell_trade_id,'acquisitionTradeId',l.source_trade_id,'tokenId',r.token_id,'realizedRawAmount',r.raw_amount::text,'holdingSeconds',r.holding_seconds,'accountingMethodologyVersion',${FIFO_ACCOUNTING_METHODOLOGY_VERSION}::text,'provenance','PHASE2_DETERMINISTIC_FIFO','legacyPopulationReplacement','EPHEMERAL_REALIZATION_UUID_V1'),true
      from wallet_realizations r join wallet_inventory_lots l on l.id=r.lot_id join wallet_trades st on st.id=r.sell_trade_id join wallet_transactions wt on wt.id=st.transaction_id
      where r.wallet_id=${walletId} and r.holding_seconds is not null and not exists(select 1 from jsonb_array_elements_text(r.issues) x where x.value in ('UNKNOWN_COST_BASIS','MISSING_SALE_PRICE')) on conflict do nothing`;
    await sql`
      with ordered as (select t.*,wt.slot,wt.signature,sum(case when t.side='BUY' then t.raw_token_amount else -t.raw_token_amount end) over(partition by t.token_id order by t.occurred_at,wt.slot,wt.signature rows between unbounded preceding and 1 preceding) before_raw from wallet_trades t join wallet_transactions wt on wt.id=t.transaction_id where t.wallet_id=${walletId} and wt.finality='finalized')
      insert into wallet_behavior_observations(wallet_id,transaction_id,token_id,source_type,source_id,feature_kind,family,numeric_value,unit,occurred_at,ordering_key,quality,methodology_version,evidence,included_in_baseline)
      select wallet_id,transaction_id,token_id,'PHASE2_HISTORICAL_DERIVATION',id::text,'EXIT_FRACTION','EXIT',least(10000::numeric,raw_token_amount*10000/before_raw),'BPS',occurred_at,to_char(occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(slot::text,20,'0')||'|'||signature||'|000',quality,${BEHAVIOR_POLICY_VERSION},jsonb_build_object('tradeId',id,'positionBeforeRaw',before_raw::text),true from ordered where side='SELL' and before_raw>0 and raw_token_amount<=before_raw on conflict do nothing`;
    await sql`
      insert into wallet_behavior_observations(wallet_id,transaction_id,token_id,source_type,source_id,feature_kind,family,categorical_value,unit,occurred_at,ordering_key,quality,methodology_version,evidence,included_in_baseline)
      select t.wallet_id,t.transaction_id,t.token_id,'PHASE2_HISTORICAL_DERIVATION',t.id::text,'VENUE_NOVELTY','VENUE_ROUTE',t.venue,'CATEGORY',t.occurred_at,to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|000',t.quality,${BEHAVIOR_POLICY_VERSION},jsonb_build_object('tradeId',t.id),true from wallet_trades t join wallet_transactions wt on wt.id=t.transaction_id where t.wallet_id=${walletId} and wt.finality='finalized' and t.venue is not null on conflict do nothing`;
    await sql`
      insert into wallet_behavior_observations(wallet_id,transaction_id,action_id,token_id,source_type,source_id,feature_kind,family,categorical_value,unit,occurred_at,ordering_key,quality,methodology_version,evidence,included_in_baseline)
      select a.wallet_id,a.transaction_id,a.id,a.token_id,'HISTORICAL_ACTION_BOUNDARY',a.id::text,'ACTION_BOUNDARY','SEQUENCE','BASELINE_SEEDED','MARKER',a.occurred_at,to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(a.action_index::text,3,'0'),a.confidence,${BEHAVIOR_POLICY_VERSION},jsonb_build_object('provenance','HISTORICAL_BASELINE_BOUNDARY'),false from wallet_economic_actions a join wallet_transactions wt on wt.id=a.transaction_id where a.wallet_id=${walletId} and wt.finality='finalized' on conflict do nothing`;
    const [boundary] = await sql<{ ordering_key: string | null }[]>`select to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(a.action_index::text,3,'0') ordering_key from wallet_economic_actions a join wallet_transactions wt on wt.id=a.transaction_id where a.wallet_id=${walletId} and wt.finality='finalized' order by a.occurred_at desc,wt.slot desc,wt.signature desc,a.action_index desc limit 1`;
    const rebuilt = await rebuildBaselines(sql, walletId, policy, now, boundary?.ordering_key ?? "0000", 1);
    await sql`update wallet_behavior_state set history_status='COMPLETED',history_complete=${history?.complete ?? false},history_cursor=null,dirty_from_ordering_key=null,watermark_ordering_key=${boundary?.ordering_key??null},updated_at=now() where wallet_id=${walletId}`;
    return { observations: (await countObservations(sql, walletId)) - before, baselines: rebuilt.persisted, diagnostics: { ...rebuilt.diagnostics, historicalBoundary: boundary?.ordering_key ?? null } };
  });
}

async function countObservations(sql: TxSql, walletId: string): Promise<number> { const [row] = await sql<{ count: number }[]>`select count(*)::int count from wallet_behavior_observations where wallet_id=${walletId}`; return row?.count ?? 0; }

async function rebuildBaselines(sql: TxSql, walletId: string, policy: BehaviorPolicy, now: Date, through: string, generation: number): Promise<{ persisted: number; diagnostics: Omit<BaselineBuildDiagnostics, "historicalBoundary"> }> {
  const cutoff = canonicalBehaviorTimestamp(new Date(now.getTime()-policy.longTermDays*86400000));
  const [eligibility] = await sql<{ included: number; within_window: number }[]>`select count(*)::int included,count(*) filter(where occurred_at>=${cutoff}::timestamptz)::int within_window from wallet_behavior_observations where wallet_id=${walletId} and included_in_baseline=true`;
  const rows = await sql<{ feature_kind: BehaviorFeatureKind; unit: string; numeric_value: string | null; categorical_value: string | null; occurred_at: Date | string }[]>`
    select feature_kind,unit,numeric_value::text,categorical_value,occurred_at from (select *,row_number() over(partition by feature_kind,unit order by occurred_at desc,id desc) rn from wallet_behavior_observations where wallet_id=${walletId} and included_in_baseline=true and occurred_at>=${canonicalBehaviorTimestamp(new Date(now.getTime()-policy.longTermDays*86400000))}::timestamptz) ranked where rn<=${policy.maxObservations}`;
  const grouped = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) { const group = `${row.feature_kind}|${row.unit}`; grouped.set(group, [...(grouped.get(group) ?? []), row]); }
  let attempted = 0;
  let persisted = 0;
  const groupDiagnostics: BaselineGroupDiagnostic[] = [];
  const [state] = await sql<{ history_complete: boolean }[]>`select history_complete from wallet_behavior_state where wallet_id=${walletId}`;
  for (const [, allItems] of grouped) {
    const first = allItems[0]; if (!first) continue; const feature = first.feature_kind;
    const groupDiagnostic: BaselineGroupDiagnostic = { featureKind: feature, unit: first.unit, selected: allItems.length, recent: 0, long: 0 };
    for (const window of [{ name:"RECENT",days:policy.recentDays },{ name:"LONG",days:policy.longTermDays }] as const) {
      const start=new Date(now.getTime()-window.days*86400000); const items=allItems.filter((item)=>parsedBehaviorTimestamp(item.occurred_at)>=start);
      if(window.name === "RECENT") groupDiagnostic.recent = items.length; else groupDiagnostic.long = items.length;
      if(items.length===0)continue;
      const cohort=`${first.unit}:${window.name}`;
      const dates = items.map((item) => parsedBehaviorTimestamp(item.occurred_at).getTime());
      const coverageDays = dates.length < 2 ? 0 : Math.floor((Math.max(...dates)-Math.min(...dates))/86400000)+1;
      const quality = baselineQuality({ count: items.length, coverageDays, historyComplete: state?.history_complete ?? false });
      const numeric = items.flatMap((item) => item.numeric_value === null ? [] : [item.numeric_value]);
      const categories = new Map<string, number>();
      for (const item of items) if (item.categorical_value !== null) categories.set(item.categorical_value,(categories.get(item.categorical_value)??0)+1);
      const statistics = numeric.length > 0 ? { kind:"NUMERIC", ...(numericStatistics(numeric) ?? {}) } : { kind:"CATEGORICAL", counts:Object.fromEntries([...categories].sort((a,b)=>b[1]-a[1]).slice(0,100)), distinctCount:categories.size };
      const inserted = await sql<{ id: string }[]>`insert into wallet_behavior_baselines(wallet_id,feature_kind,cohort,window_start,window_end,through_ordering_key,observation_count,coverage_days,quality,history_complete,completeness_bps,statistics,methodology_version,evaluation_generation,generated_at) values(${walletId},${feature},${cohort},${canonicalBehaviorTimestamp(start)}::timestamptz,${canonicalBehaviorTimestamp(now)}::timestamptz,${through},${items.length},${coverageDays},${quality},${state?.history_complete??false},${state?.history_complete?10000:0},${JSON.stringify(statistics)}::jsonb,${BEHAVIOR_POLICY_VERSION},${generation},${canonicalBehaviorTimestamp(now)}::timestamptz)
        on conflict(wallet_id,feature_kind,cohort,through_ordering_key,methodology_version,evaluation_generation) do update set window_start=excluded.window_start,window_end=excluded.window_end,observation_count=excluded.observation_count,coverage_days=excluded.coverage_days,quality=excluded.quality,history_complete=excluded.history_complete,completeness_bps=excluded.completeness_bps,statistics=excluded.statistics,generated_at=excluded.generated_at
        where (wallet_behavior_baselines.window_start,wallet_behavior_baselines.window_end,wallet_behavior_baselines.observation_count,wallet_behavior_baselines.coverage_days,wallet_behavior_baselines.quality,wallet_behavior_baselines.history_complete,wallet_behavior_baselines.completeness_bps,wallet_behavior_baselines.statistics) is distinct from (excluded.window_start,excluded.window_end,excluded.observation_count,excluded.coverage_days,excluded.quality,excluded.history_complete,excluded.completeness_bps,excluded.statistics) returning id`;
      attempted += 1;
      persisted += inserted.length;
    }
    groupDiagnostics.push(groupDiagnostic);
  }
  const included = eligibility?.included ?? 0;
  const withinWindow = eligibility?.within_window ?? 0;
  return { persisted, diagnostics: { methodologyVersion: BEHAVIOR_POLICY_VERSION, policy: { recentDays: policy.recentDays, longTermDays: policy.longTermDays, maxObservations: policy.maxObservations }, historyComplete: state?.history_complete ?? false, includedObservationCount: included, selectedObservationCount: rows.length, excludedByLongTermWindow: included-withinWindow, removedByPerFeatureCap: withinWindow-rows.length, groupCount: grouped.size, groups: groupDiagnostics, attemptedSnapshotCount: attempted, persistedSnapshotCount: persisted } };
}

export async function evaluateWalletBehavior(database: Database, walletId: string, policy: BehaviorPolicy, metrics?: MetricsRegistry, now = new Date(), mode: BehaviorEvaluationMode = "ALERT"): Promise<{ evaluated: number; anomalies: number; skipped: number; duplicates: number; notificationIds: readonly string[] }> {
  const started = performance.now();
  const result = await database.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${walletId}, 0))`;
    const [state] = await sql<{ watermark_ordering_key: string | null; history_complete: boolean; evaluation_generation: number }[]>`select watermark_ordering_key,history_complete,evaluation_generation from wallet_behavior_state where wallet_id=${walletId} for update`;
    if (!state) return { evaluated:0, anomalies:0, skipped:0, duplicates:0, notificationIds:[] as string[] };
    const actionRows = await sql<ActionDatabaseRow[]>`select a.*,wt.slot,wt.signature,wt.finality,t.mint,exists(select 1 from wallet_behavior_observations o where o.action_id=a.id) behavior_observed from wallet_economic_actions a join wallet_transactions wt on wt.id=a.transaction_id left join tokens t on t.id=a.token_id where a.wallet_id=${walletId} and wt.finality='finalized' order by a.occurred_at,wt.slot,wt.signature,a.action_index`;
    const actions: ActionRow[] = actionRows.map((action) => ({ ...action, occurred_at: parsedBehaviorTimestamp(action.occurred_at) }));
    let evaluated=0, anomalyCount=0, skipped=0, duplicates=0, watermark=state.watermark_ordering_key; const notificationIds:string[]=[];
    let generation=state.evaluation_generation;
    const existingWatermark=watermark;
    const late=existingWatermark===null?undefined:actions.find((candidate)=>behaviorOrderingKey(candidate)<=existingWatermark && !candidateBehaviorWasObserved(candidate));
    if(late){
      const dirty=behaviorOrderingKey(late); generation+=1;
      metrics?.increment("anomaly_repair_total",{reason:"late_finalized_action"});
      await sql`update wallet_behavior_state set dirty_from_ordering_key=${dirty},evaluation_generation=${generation},updated_at=now() where wallet_id=${walletId}`;
      if(mode === "ALERT") {
        await sql`update wallet_anomalies a set superseded_at=${canonicalBehaviorTimestamp(now)}::timestamptz,supersession_reason='LATE_FINALIZED_ACTION_REPAIR' from wallet_economic_actions e join wallet_transactions wt on wt.id=e.transaction_id where a.action_id=e.id and a.wallet_id=${walletId} and a.superseded_at is null and (to_char(wt.occurred_at at time zone 'UTC',${CANONICAL_BEHAVIOR_TIMESTAMP_SQL_FORMAT})||'|'||lpad(wt.slot::text,20,'0')||'|'||wt.signature||'|'||lpad(e.action_index::text,3,'0'))>=${dirty}`;
        await sql`update wallet_behavior_incidents set status='SUPERSEDED',updated_at=now() where wallet_id=${walletId} and status='OPEN' and latest_ordering_key>=${dirty}`;
      }
      await sql`delete from wallet_behavior_observations where wallet_id=${walletId} and action_id is not null and source_type in ('LIVE_ECONOMIC_ACTION',${HOLDING_DURATION_SOURCE_TYPE}) and ordering_key>=${dirty}`;
      const previous=actions.filter((candidate)=>behaviorOrderingKey(candidate)<dirty).at(-1); watermark=previous?behaviorOrderingKey(previous):null;
      await sql`update wallet_behavior_state set watermark_ordering_key=${watermark} where wallet_id=${walletId}`;
    }
    for (const action of actions) {
      const key=behaviorOrderingKey(action); if (watermark!==null && key<=watermark) continue;
      const observations=await observationsForAction(sql,action,walletId);
      const facts: Fact[]=[];
      for(const observation of observations){
        const observationId=await insertObservation(sql,walletId,action,key,observation);
        const outcome=await evaluateObservation(sql,walletId,key,observation,policy,state.history_complete,generation);
        if(outcome.fact)facts.push(outcome.fact);
        if(mode === "SHADOW") {
          const inserted=await persistShadowEvaluation(sql,{walletId,action,observationId,observation,key,outcome,generation,now});
          if(!inserted)duplicates+=1;
          else if(outcome.status === "NON_EVALUABLE") skipped+=1;
          else if(outcome.fact){anomalyCount+=1;metrics?.increment("behavior_shadow_anomalies_total",{feature:outcome.fact.feature,severity:outcome.fact.tier});}
        }
      }
      if(mode === "ALERT") {
        for(const fact of facts){const [inserted]=await sql<{id:string}[]>`insert into wallet_anomalies(wallet_id,transaction_id,action_id,baseline_id,feature_kind,family,observed,percentile_lower_bps,percentile_upper_bps,baseline_quality,severity_contribution,rule_id,evidence,methodology_version,evaluation_generation,evaluated_at) values(${walletId},${action.transaction_id},${action.id},${fact.baselineId},${fact.feature},${fact.family},${JSON.stringify(fact.observed)}::jsonb,${fact.lower},${fact.upper},${fact.quality},${fact.tier},${fact.ruleId},${JSON.stringify(fact.evidence)}::jsonb,${BEHAVIOR_POLICY_VERSION},${generation},${canonicalBehaviorTimestamp(now)}::timestamptz) on conflict do nothing returning id`;if(inserted){anomalyCount+=1;metrics?.increment("anomalies_detected_total",{kind:fact.feature,severity:fact.tier});}}
        if(facts.length>0){const notification=await correlateIncident(sql,walletId,action,key,facts,policy,now,generation);if(notification)notificationIds.push(notification);}
        await rebuildBaselines(sql,walletId,policy,now,key,generation);
      }
      watermark=key; evaluated+=1;
      await sql`update wallet_behavior_state set watermark_ordering_key=${key},dirty_from_ordering_key=null,updated_at=now() where wallet_id=${walletId}`;
    }
    return {evaluated,anomalies:anomalyCount,skipped,duplicates,notificationIds};
  });
  metrics?.increment("behavior_evaluations_total",{mode,outcome:"completed"},result.evaluated);
  metrics?.increment("behavior_evaluation_skipped_total",{mode},result.skipped);
  metrics?.increment("behavior_evaluation_duplicates_total",{mode},result.duplicates);
  metrics?.observe("behavior_evaluation_duration_ms",performance.now()-started,{mode});
  return result;
}

interface ActionRow { id:string; wallet_id:string; transaction_id:string; action_index:number; action:string; token_id:string|null; raw_token_amount:string|null; token_decimals:number|null; consideration_mint:string|null; consideration_raw_amount:string|null; consideration_decimals:number|null; position_impact_numerator:string|null; position_impact_denominator:string|null; confidence:string; occurred_at:Date; native_destination:string|null; native_pre_balance_lamports:string|null; native_post_balance_lamports:string|null; native_transfer_lamports:string|null; slot:bigint; signature:string; finality:string; mint:string|null; behavior_observed?:boolean; }
type ActionDatabaseRow = Omit<ActionRow, "occurred_at"> & { occurred_at: Date | string };
const candidateBehaviorWasObserved=(action:ActionRow)=>action.behavior_observed===true;
interface Fact {feature:BehaviorFeatureKind;family:AnomalyFamily;tier:AnomalySeverity;quality:BaselineQuality;baselineId:string;lower:number|null;upper:number|null;ruleId:string;observed:Record<string,EvidenceValue>;evidence:Record<string,EvidenceValue>}
interface EvaluationOutcome { status:"EVALUATED"|"NON_EVALUABLE"; reasonCode:string|null; baselineId:string|null; baselineMethodologyVersion:string|null; baselineObservationCount:number|null; baselineStatistics:Record<string,unknown>|null; fact:Fact|null; direction:BehaviorDeviationDirection|null; deviationBps:number|null; }

async function observationsForAction(sql:TxSql,action:ActionRow,walletId:string):Promise<Observation[]>{
  const out:Observation[]=[]; const sol="So11111111111111111111111111111111111111112";
  const slot=action.slot.toString();
  if(action.action==="BUY"&&action.consideration_raw_amount&&action.consideration_decimals!==null){
    if(action.consideration_mint===sol){const value=new Decimal(action.consideration_raw_amount).div(new Decimal(10).pow(action.consideration_decimals)).toFixed();out.push({featureKind:"POSITION_SIZE_SOL",family:"SIZE",numericValue:value,unit:"SOL",evidence:{action:action.action},tokenId:action.token_id});}
    else{const [trade]=await sql<{estimated_usd_value:string|null}[]>`select estimated_usd_value::text from wallet_trades where transaction_id=${action.transaction_id} and token_id=${action.token_id} and side='BUY' order by occurred_at,id limit 1`;if(trade?.estimated_usd_value)out.push({featureKind:"POSITION_SIZE_USD",family:"SIZE",numericValue:trade.estimated_usd_value,unit:"USD",evidence:{action:action.action,source:"PHASE2_ESTIMATED_USD_VALUE"},tokenId:action.token_id});}
  }
  if((action.action==="PARTIAL_EXIT"||action.action==="FULL_EXIT")&&action.position_impact_numerator&&action.position_impact_denominator&&BigInt(action.position_impact_denominator)>0n){
    out.push({featureKind:"EXIT_FRACTION",family:"EXIT",numericValue:(BigInt(action.position_impact_numerator)*10000n/BigInt(action.position_impact_denominator)).toString(),unit:"BPS",evidence:{action:action.action},tokenId:action.token_id});
    const holds=await sql<{token_id:string;sell_trade_id:string;acquisition_trade_id:string;raw_amount:string;holding_seconds:number}[]>`select r.token_id,r.sell_trade_id,l.source_trade_id acquisition_trade_id,r.raw_amount::text raw_amount,r.holding_seconds from wallet_realizations r join wallet_inventory_lots l on l.id=r.lot_id join wallet_trades t on t.id=r.sell_trade_id where t.transaction_id=${action.transaction_id} and r.holding_seconds is not null and not exists(select 1 from jsonb_array_elements_text(r.issues) x where x.value in ('UNKNOWN_COST_BASIS','MISSING_SALE_PRICE')) order by r.sell_trade_id,l.source_trade_id,r.raw_amount`;
    for(const hold of holds){const semanticSourceId=holdingDurationSemanticSourceId({walletId,tokenId:hold.token_id,sellTradeId:hold.sell_trade_id,acquisitionTradeId:hold.acquisition_trade_id,realizedRawAmount:hold.raw_amount});out.push({featureKind:"HOLDING_DURATION",family:"DURATION",numericValue:String(hold.holding_seconds),unit:"SECONDS",tokenId:hold.token_id,realization:{semanticSourceId,sellTradeId:hold.sell_trade_id,acquisitionTradeId:hold.acquisition_trade_id,realizedRawAmount:BigInt(hold.raw_amount).toString(),accountingMethodologyVersion:FIFO_ACCOUNTING_METHODOLOGY_VERSION},evidence:{basis:"PHASE2_DETERMINISTIC_FIFO",semanticRealizationId:semanticSourceId,sellTradeId:hold.sell_trade_id,acquisitionTradeId:hold.acquisition_trade_id,realizedRawAmount:BigInt(hold.raw_amount).toString(),holdingSeconds:hold.holding_seconds,accountingMethodologyVersion:FIFO_ACCOUNTING_METHODOLOGY_VERSION}});}
  }
  if(action.action==="TRANSFER_OUT"&&action.native_transfer_lamports){out.push({featureKind:"NATIVE_TRANSFER_SIZE",family:"TRANSFER",numericValue:new Decimal(action.native_transfer_lamports).div(1e9).toFixed(),unit:"SOL",evidence:{destinationAvailable:action.native_destination!==null}});if(action.native_pre_balance_lamports&&BigInt(action.native_pre_balance_lamports)>0n)out.push({featureKind:"NATIVE_BALANCE_FRACTION",family:"TRANSFER",numericValue:(BigInt(action.native_transfer_lamports)*10000n/BigInt(action.native_pre_balance_lamports)).toString(),unit:"BPS",evidence:{preBalanceLamports:action.native_pre_balance_lamports,postBalanceLamports:action.native_post_balance_lamports}});if(action.native_destination)out.push({featureKind:"TRANSFER_DESTINATION_NOVELTY",family:"TRANSFER",categoricalValue:action.native_destination,unit:"CATEGORY",evidence:{destination:action.native_destination}});}
  const [frequency]=await sql<{five:number;one_hour:number}[]>`select count(*) filter(where a.occurred_at>=${canonicalBehaviorTimestamp(new Date(action.occurred_at.getTime()-300000))}::timestamptz)::int five,count(*) filter(where a.occurred_at>=${canonicalBehaviorTimestamp(new Date(action.occurred_at.getTime()-3600000))}::timestamptz)::int one_hour from wallet_economic_actions a join wallet_transactions wt on wt.id=a.transaction_id where a.wallet_id=${walletId} and (a.occurred_at,wt.slot,wt.signature,a.action_index)<(${canonicalBehaviorTimestamp(action.occurred_at)}::timestamptz,${slot}::bigint,${action.signature},${action.action_index})`;out.push({featureKind:"ACTION_FREQUENCY_5M",family:"FREQUENCY",numericValue:String((frequency?.five??0)+1),unit:"COUNT",evidence:{windowSeconds:300}},{featureKind:"ACTION_FREQUENCY_1H",family:"FREQUENCY",numericValue:String((frequency?.one_hour??0)+1),unit:"COUNT",evidence:{windowSeconds:3600}});
  const prior=await sql<{action:string;occurred_at:Date|string}[]>`select a.action,a.occurred_at from wallet_economic_actions a join wallet_transactions wt on wt.id=a.transaction_id where a.wallet_id=${walletId} and (a.occurred_at,wt.slot,wt.signature,a.action_index)<(${canonicalBehaviorTimestamp(action.occurred_at)}::timestamptz,${slot}::bigint,${action.signature},${action.action_index}) order by a.occurred_at desc,wt.slot desc,wt.signature desc,a.action_index desc limit 3`;const sequence=[...prior.reverse().map(x=>({action:x.action,occurredAt:parsedBehaviorTimestamp(x.occurred_at)})),{action:action.action,occurredAt:action.occurred_at}];for(const length of [2,3,4] as const){const gram=actionNgrams(sequence,length).at(-1);if(gram)out.push({featureKind:"ACTION_SEQUENCE",family:"SEQUENCE",categoricalValue:gram,unit:`NGRAM_${String(length)}`,evidence:{length}});}
  return out;
}

async function evaluateObservation(sql:TxSql,walletId:string,key:string,observation:Observation,policy:BehaviorPolicy,historyComplete:boolean,generation:number):Promise<EvaluationOutcome>{
  const cohort=`${observation.unit}:LONG`;
  const [candidate]=await sql<{id:string;quality:BaselineQuality;observation_count:number;methodology_version:string;window_start:Date|string;window_end:Date|string;through_ordering_key:string;statistics:Record<string,unknown>}[]>`select id,quality,observation_count,methodology_version,window_start,window_end,through_ordering_key,statistics from wallet_behavior_baselines where wallet_id=${walletId} and feature_kind=${observation.featureKind} and cohort=${cohort} and evaluation_generation<=${generation} order by evaluation_generation desc,generated_at desc,id desc limit 1`;
  const base=(reasonCode:string):EvaluationOutcome=>({status:"NON_EVALUABLE",reasonCode,baselineId:candidate?.id??null,baselineMethodologyVersion:candidate?.methodology_version??null,baselineObservationCount:candidate?.observation_count??null,baselineStatistics:candidate?.statistics??null,fact:null,direction:null,deviationBps:null});
  if(!historyComplete)return base("HISTORY_INCOMPLETE");
  if(!candidate)return base("BASELINE_MISSING");
  if(candidate.methodology_version!==BEHAVIOR_POLICY_VERSION)return base("METHODOLOGY_MISMATCH");
  if(candidate.quality==="INSUFFICIENT")return base("BASELINE_INSUFFICIENT");
  if(candidate.through_ordering_key>=key)return base("OBSERVATION_NOT_AFTER_BASELINE");
  const evaluated=(fact:Fact|null,direction:BehaviorDeviationDirection|null,deviationBps:number|null):EvaluationOutcome=>({status:"EVALUATED",reasonCode:fact?"ANOMALY":"NORMAL",baselineId:candidate.id,baselineMethodologyVersion:candidate.methodology_version,baselineObservationCount:candidate.observation_count,baselineStatistics:candidate.statistics,fact,direction,deviationBps});
  if(observation.numericValue!==undefined){
    const values=(await sql<{value:string}[]>`select numeric_value::text value from wallet_behavior_observations where wallet_id=${walletId} and feature_kind=${observation.featureKind} and unit=${observation.unit} and numeric_value is not null and ordering_key<=${candidate.through_ordering_key} and occurred_at>=${candidate.window_start} and occurred_at<=${candidate.window_end} order by ordering_key desc limit ${policy.maxObservations}`).map(x=>x.value);
    const percentile=empiricalPercentile(observation.numericValue,values);if(!percentile)return base("INSUFFICIENT_COMPARABLE_OBSERVATIONS");
    const deviation=classifyNumericDeviation(percentile,values.length);
    if(!deviation)return evaluated(null,null,null);
    return evaluated({feature:observation.featureKind,family:observation.family,tier:deviation.severity,quality:candidate.quality,baselineId:candidate.id,lower:percentile.lowerBps,upper:percentile.upperBps,ruleId:deviation.ruleId,observed:{value:observation.numericValue,unit:observation.unit},evidence:observation.evidence},deviation.direction,deviation.deviationBps);
  }
  const length=observation.featureKind==="ACTION_SEQUENCE"?Number(observation.unit.replace("NGRAM_","")):null;const required=length===2?100:length===3?150:length===4?200:20;
  const [counts]=await sql<{total:number;matching:number}[]>`select count(*)::int total,count(*) filter(where categorical_value=${observation.categoricalValue??""})::int matching from wallet_behavior_observations where wallet_id=${walletId} and feature_kind=${observation.featureKind} and unit=${observation.unit} and categorical_value is not null and ordering_key<=${candidate.through_ordering_key} and occurred_at>=${candidate.window_start} and occurred_at<=${candidate.window_end}`;
  const total=counts?.total??0;if(total<required)return base("INSUFFICIENT_COMPARABLE_OBSERVATIONS");
  const matching=counts?.matching??0;const deviation=classifyCategoricalDeviation(matching,total,required,observation.unit);if(!deviation)return evaluated(null,null,null);
  const frequency=Math.floor(matching*10000/total);
  return evaluated({feature:observation.featureKind,family:observation.family,tier:deviation.severity,quality:candidate.quality,baselineId:candidate.id,lower:null,upper:null,ruleId:deviation.ruleId,observed:{value:observation.categoricalValue??null,frequencyBps:frequency,opportunities:total},evidence:observation.evidence},deviation.direction,deviation.deviationBps);
}

async function insertObservation(sql:TxSql,walletId:string,action:ActionRow,key:string,o:Observation):Promise<string>{
  const realization=o.realization;const sourceType=realization?HOLDING_DURATION_SOURCE_TYPE:'LIVE_ECONOMIC_ACTION';const sourceId=realization?.semanticSourceId??`${action.id}:${o.unit}`;
  const [inserted]=await sql<{id:string}[]>`insert into wallet_behavior_observations(wallet_id,transaction_id,action_id,token_id,source_type,source_id,feature_kind,family,sell_trade_id,acquisition_trade_id,realized_raw_amount,accounting_methodology_version,numeric_value,categorical_value,unit,occurred_at,ordering_key,quality,methodology_version,evidence,included_in_baseline) values(${walletId},${action.transaction_id},${action.id},${o.tokenId??null},${sourceType},${sourceId},${o.featureKind},${o.family},${realization?.sellTradeId??null},${realization?.acquisitionTradeId??null},${realization?.realizedRawAmount??null},${realization?.accountingMethodologyVersion??null},${o.numericValue??null},${o.categoricalValue??null},${o.unit},${canonicalBehaviorTimestamp(action.occurred_at)}::timestamptz,${key},${action.confidence},${BEHAVIOR_POLICY_VERSION},${JSON.stringify(o.evidence)}::jsonb,true) on conflict do nothing returning id`;
  if(inserted)return inserted.id;
  const [existing]=await sql<{id:string}[]>`select id from wallet_behavior_observations where source_type=${sourceType} and source_id=${sourceId} and feature_kind=${o.featureKind} and methodology_version=${BEHAVIOR_POLICY_VERSION}`;
  if(!existing)throw new Error("BEHAVIOR_OBSERVATION_IDEMPOTENCY_LOOKUP_FAILED");return existing.id;
}

async function persistShadowEvaluation(sql:TxSql,input:{walletId:string;action:ActionRow;observationId:string;observation:Observation;key:string;outcome:EvaluationOutcome;generation:number;now:Date}):Promise<boolean>{
  const fact=input.outcome.fact;const groupKey=`shadow-v1|wallet=${input.walletId}|action=${input.action.id}|generation=${String(input.generation)}`;
  const statistics=input.outcome.baselineStatistics;const baselineSummary=statistics?Object.fromEntries(["kind","minimum","q1","median","q3","maximum","mad","distinctCount"].flatMap((key)=>statistics[key]===undefined?[]:[[key,statistics[key]]])):null;
  const evidence={orderingKey:input.key,signature:input.action.signature,action:input.action.action,tokenId:input.observation.tokenId??input.action.token_id,observed:fact?.observed??{value:input.observation.numericValue??input.observation.categoricalValue??null,unit:input.observation.unit},baselineObservationCount:input.outcome.baselineObservationCount,baselineSummary,observationEvidence:input.observation.evidence};
  const [inserted]=await sql<{id:string}[]>`insert into wallet_behavior_shadow_evaluations(wallet_id,transaction_id,action_id,observation_id,baseline_id,feature_kind,family,status,reason_code,is_anomaly,severity,direction,deviation_bps,percentile_lower_bps,percentile_upper_bps,rule_id,group_key,evidence,methodology_version,baseline_methodology_version,evaluation_generation,evaluated_at) values(${input.walletId},${input.action.transaction_id},${input.action.id},${input.observationId},${input.outcome.baselineId},${input.observation.featureKind},${input.observation.family},${input.outcome.status},${input.outcome.reasonCode},${fact!==null},${fact?.tier??null},${input.outcome.direction},${input.outcome.deviationBps},${fact?.lower??null},${fact?.upper??null},${fact?.ruleId??null},${groupKey},${JSON.stringify(evidence)}::jsonb,${BEHAVIOR_POLICY_VERSION},${input.outcome.baselineMethodologyVersion},${input.generation},${canonicalBehaviorTimestamp(input.now)}::timestamptz) on conflict do nothing returning id`;
  return inserted!==undefined;
}

async function correlateIncident(sql:TxSql,walletId:string,action:ActionRow,key:string,facts:Fact[],policy:BehaviorPolicy,now:Date,generation:number):Promise<string|null>{
  const derived=deriveIncidentSeverity(facts.map(f=>({family:f.family,tier:f.tier,baselineQuality:f.quality})));
  if(!derived.severity)return null;
  const [prior]=await sql<{action:string;token_id:string|null}[]>`select a.action,a.token_id from wallet_economic_actions a join wallet_transactions wt on wt.id=a.transaction_id where a.wallet_id=${walletId} and (a.occurred_at,wt.slot,wt.signature,a.action_index)<(${canonicalBehaviorTimestamp(action.occurred_at)}::timestamptz,${action.slot.toString()}::bigint,${action.signature},${action.action_index}) order by a.occurred_at desc,wt.slot desc,wt.signature desc,a.action_index desc limit 1`;
  const transitionRelated=(prior?.action==="FULL_EXIT"&&action.action==="ACCOUNT_CLOSE")||(prior?.action==="ACCOUNT_CLOSE"&&action.action==="TRANSFER_OUT");
  const [candidate]=await sql<{id:string;severity:AnomalySeverity;revision:number;families:string[];rule_ids:string[];anchor_token_id:string|null}[]>`select i.id,i.severity,i.revision,i.families,i.rule_ids,a.token_id anchor_token_id from wallet_behavior_incidents i join wallet_economic_actions a on a.id=i.anchor_action_id where i.wallet_id=${walletId} and i.status='OPEN' and i.evaluation_generation=${generation} and i.latest_at>=${canonicalBehaviorTimestamp(new Date(action.occurred_at.getTime()-policy.incidentWindowMinutes*60000))}::timestamptz order by i.latest_at desc limit 1`;
  const existing=candidate&&((candidate.anchor_token_id!==null&&candidate.anchor_token_id===action.token_id)||transitionRelated)?candidate:undefined;
  let incidentId:string;
  let revision:number;
  let incidentSeverity:AnomalySeverity=derived.severity;
  const severityRank:Record<AnomalySeverity,number>={NOTABLE:1,UNUSUAL:2,EXTREME:3};
  if(existing){
    const families=[...new Set([...existing.families,...derived.families])];
    const materiallyNew=families.length>existing.families.length;
    const compoundNotable=existing.severity==="NOTABLE"&&derived.severity==="NOTABLE"&&families.length>=2;
    const nextSeverity=compoundNotable?"UNUSUAL":derived.severity;
    const escalated=severityRank[nextSeverity]>severityRank[existing.severity];
    revision=existing.revision+(materiallyNew||escalated?1:0);
    incidentId=existing.id;
    const severity=escalated?nextSeverity:existing.severity;
    incidentSeverity=severity;
    const rules=[...new Set([...existing.rule_ids,...derived.ruleIds,...(compoundNotable?["SEVERITY_V1_TWO_INDEPENDENT_NOTABLE_FAMILIES"]:[])])];
    await sql`update wallet_behavior_incidents set latest_ordering_key=${key},latest_at=${canonicalBehaviorTimestamp(action.occurred_at)}::timestamptz,severity=${severity},revision=${revision},rule_ids=${JSON.stringify(rules)}::jsonb,families=${JSON.stringify(families)}::jsonb,updated_at=now() where id=${incidentId}`;
  }else{
    revision=1;
    const [created]=await sql<{id:string}[]>`insert into wallet_behavior_incidents(wallet_id,anchor_action_id,first_ordering_key,latest_ordering_key,opened_at,latest_at,severity,revision,rule_ids,families,baseline_quality,methodology_version,evaluation_generation) values(${walletId},${action.id},${key},${key},${canonicalBehaviorTimestamp(action.occurred_at)}::timestamptz,${canonicalBehaviorTimestamp(action.occurred_at)}::timestamptz,${derived.severity},1,${JSON.stringify(derived.ruleIds)}::jsonb,${JSON.stringify(derived.families)}::jsonb,${facts.map(f=>f.quality).sort().at(-1)??"LOW"},${BEHAVIOR_POLICY_VERSION},${generation}) returning id`;
    if(!created)return null;
    incidentId=created.id;
  }
  await sql`update wallet_anomalies set incident_id=${incidentId} where action_id=${action.id} and methodology_version=${BEHAVIOR_POLICY_VERSION}`;
  if(incidentSeverity==="NOTABLE")return null;
  const payload={incidentId,revision,severity:incidentSeverity,walletId,action:action.action,occurredAt:action.occurred_at.toISOString(),facts:facts.map(f=>({feature:f.feature,tier:f.tier,quality:f.quality,observed:f.observed,ruleId:f.ruleId})),ruleIds:[...derived.ruleIds]};
  const [notification]=await sql<{id:string}[]>`insert into wallet_anomaly_notifications(incident_id,revision,provider,destination_key,payload) values(${incidentId},${revision},'telegram','default',${JSON.stringify(payload)}::jsonb) on conflict do nothing returning id`;
  return notification?.id??null;
}

export async function deliverBehaviorNotifications(database:Database,notifier:NotificationProvider|undefined,walletId:string):Promise<number>{if(!notifier)return 0;const rows=await database.sql<{id:string;incident_id:string;revision:number;payload:Record<string,unknown>}[]>`select n.id,n.incident_id,n.revision,n.payload from wallet_anomaly_notifications n join wallet_behavior_incidents i on i.id=n.incident_id where i.wallet_id=${walletId} and n.status in ('PENDING','RETRYING') and n.next_attempt_at<=now() order by n.created_at limit 20`;let delivered=0;for(const row of rows){try{const p=row.payload;const result=await notifier.deliver({deduplicationKey:`behavior:${row.incident_id}:${String(row.revision)}:default`,severity:p["severity"]==="EXTREME"?"CRITICAL":"HIGH",text:formatBehaviorMessage(p)});await database.sql`update wallet_anomaly_notifications set status='DELIVERED',external_id=${result.externalId},delivered_at=now(),attempt_count=attempt_count+1,last_error_code=null where id=${row.id}`;delivered+=1;}catch{await database.sql`update wallet_anomaly_notifications set status='RETRYING',attempt_count=attempt_count+1,last_error_code='DELIVERY_FAILED',next_attempt_at=now()+interval '5 minutes' where id=${row.id}`;}}return delivered;}
function formatBehaviorMessage(payload:Record<string,unknown>):string {
  const facts=Array.isArray(payload["facts"])?payload["facts"] as Record<string,unknown>[]:[];
  const rules=Array.isArray(payload["ruleIds"])?payload["ruleIds"] as string[]:[];
  return [`${String(payload["severity"])} WALLET BEHAVIOR`,`Wallet: ${String(payload["walletId"]).slice(0,8)}...`,"",...facts.map((fact)=>`- ${String(fact["feature"]).replaceAll("_"," ")}: ${JSON.stringify(fact["observed"])} (${String(fact["quality"])} baseline)`),"",`Evidence rules: ${rules.join(", ")}`,"Observed deviation only; no motive or trading recommendation is inferred."].join("\n");
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-unnecessary-condition
function behaviorMessage(payload:Record<string,unknown>):string{const facts=Array.isArray(payload["facts"])?payload["facts"] as Record<string,unknown>[]:[];return[`${payload["severity"]==="EXTREME"?"🚨":"⚠️"} ${String(payload["severity"])} WALLET BEHAVIOR`,`Wallet: ${String(payload["walletId"]).slice(0,8)}…`,"",...facts.map(f=>`• ${String(f["feature"]).replaceAll("_"," ")}: ${JSON.stringify(f["observed"])} (${String(f["quality"])} baseline)`),"",`Evidence rules: ${(payload["ruleIds"] as string[]??[]).join(", ")}`,"Observed deviation only; no motive or trading recommendation is inferred."].join("\n");}
