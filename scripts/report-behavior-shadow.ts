import process from "node:process";
import { parseConfig } from "@swi/config";
import { createDatabase } from "@swi/db";

const walletId = process.argv[2];
const range = process.argv[3] ?? "24h";
if (!walletId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(walletId)) throw new Error("Usage: npm run behavior:shadow-report -- <wallet-uuid> [24h|72h|7d]");
const hours = range === "24h" ? 24 : range === "72h" ? 72 : range === "7d" ? 168 : null;
if (hours === null) throw new Error("SHADOW_REPORT_RANGE_MUST_BE_24h_72h_OR_7d");

const config = parseConfig(process.env);
const database = createDatabase(config.DATABASE_URL, { maxConnections: 1, quiet: true });
const since = new Date(Date.now() - hours * 60 * 60_000);
try {
  const [summary] = await database.sql<{total:number;evaluable:number;non_evaluable:number;anomalies:number}[]>`
    select count(*)::int total,count(*) filter(where status='EVALUATED')::int evaluable,
      count(*) filter(where status='NON_EVALUABLE')::int non_evaluable,
      count(*) filter(where is_anomaly)::int anomalies
    from wallet_behavior_shadow_evaluations where wallet_id=${walletId} and evaluated_at>=${since.toISOString()}::timestamptz`;
  const byFeature = await database.sql`select feature_kind,count(*)::int evaluated,count(*) filter(where is_anomaly)::int anomalies,count(*) filter(where status='NON_EVALUABLE')::int non_evaluable from wallet_behavior_shadow_evaluations where wallet_id=${walletId} and evaluated_at>=${since.toISOString()}::timestamptz group by feature_kind order by feature_kind`;
  const bySeverity = await database.sql`select coalesce(severity,'NONE') severity,count(*)::int count from wallet_behavior_shadow_evaluations where wallet_id=${walletId} and evaluated_at>=${since.toISOString()}::timestamptz group by severity order by count desc,severity`;
  const skips = await database.sql`select reason_code,count(*)::int count from wallet_behavior_shadow_evaluations where wallet_id=${walletId} and evaluated_at>=${since.toISOString()}::timestamptz and status='NON_EVALUABLE' group by reason_code order by count desc,reason_code`;
  const top = await database.sql`select feature_kind,severity,direction,deviation_bps,rule_id,group_key,evidence->>'signature' signature,evidence->'observed' observed,evaluated_at from wallet_behavior_shadow_evaluations where wallet_id=${walletId} and evaluated_at>=${since.toISOString()}::timestamptz and is_anomaly order by deviation_bps desc nulls last,evaluated_at desc limit 25`;
  const groups = await database.sql`select group_key,min(transaction_id::text) transaction_id,min(action_id::text) action_id,array_agg(feature_kind order by feature_kind) filter(where is_anomaly) contributing_features,max(case severity when 'EXTREME' then 3 when 'UNUSUAL' then 2 when 'NOTABLE' then 1 else 0 end)::int severity_rank,jsonb_agg(jsonb_build_object('feature',feature_kind,'severity',severity,'direction',direction,'ruleId',rule_id) order by feature_kind) filter(where is_anomaly) combined_evidence from wallet_behavior_shadow_evaluations where wallet_id=${walletId} and evaluated_at>=${since.toISOString()}::timestamptz group by group_key having count(*) filter(where is_anomaly)>0 order by max(evaluated_at) desc limit 100`;
  const baselines = await database.sql`select baseline_id,baseline_methodology_version,evaluation_generation,count(*)::int evaluations from wallet_behavior_shadow_evaluations where wallet_id=${walletId} and evaluated_at>=${since.toISOString()}::timestamptz group by baseline_id,baseline_methodology_version,evaluation_generation order by evaluation_generation desc,baseline_id`;
  const errors = await database.sql`select job_id,error_code,error_message,attempt_count,failed_at,resolved_at from processing_failures where queue='analysis' and safe_context->>'jobName'='behavior-evaluate' and safe_context->>'walletId'=${walletId} and failed_at>=${since.toISOString()}::timestamptz order by failed_at desc limit 100`;
  const total=summary?.total??0;const anomalies=summary?.anomalies??0;
  process.stdout.write(`${JSON.stringify({walletId,range:{from:since.toISOString(),to:new Date().toISOString(),hours},summary:{...summary,anomalyRateBps:total===0?0:Math.floor(anomalies*10_000/total),duplicateSuppression:"ENFORCED_BY_UNIQUE_CONSTRAINT_NOT_PERSISTED_AS_ROWS"},byFeature,bySeverity,nonEvaluableReasons:skips,evaluatorErrors:errors,topDeviations:top,proposedIncidentGroups:groups,baselines},null,2)}\n`);
} finally {
  await database.close();
}
