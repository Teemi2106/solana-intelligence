import { readFileSync } from "node:fs";
import process from "node:process";
import postgres from "postgres";

const address = process.argv[2];
if (!address) throw new Error("Usage: npm run wallet:diagnose -- <wallet-address>");

const environment = { ...process.env };
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (!match) continue;
  const [, name, rawValue] = match;
  if (!name || rawValue === undefined || environment[name] !== undefined) continue;
  const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
  environment[name] = quoted ? rawValue.slice(1, -1) : rawValue;
}
if (!environment["DATABASE_URL"]) throw new Error("DATABASE_URL is required");

const sql = postgres(environment["DATABASE_URL"], { max: 1, prepare: false });
try {
  const [counts] = await sql`
    select
      count(distinct wt.id)::int as transactions_ingested,
      count(distinct wt.id) filter (where wt.succeeded)::int as successful,
      count(distinct wt.id) filter (where not wt.succeeded)::int as failed,
      count(distinct wt.id) filter (where tf.id is not null)::int as transactions_with_token_balance_changes,
      count(distinct wt.id) filter (where (wt.normalized_payload->>'nativeSolDeltaLamports')::numeric <> 0 or tok.mint = 'So11111111111111111111111111111111111111112')::int as transactions_with_sol_or_wsol_changes,
      count(distinct wt.id) filter (where wt.normalized_payload->>'providerType' = 'SWAP')::int as provider_recognized_swaps,
      count(distinct wt.id)::int as normalized_transactions_stored,
      count(distinct tf.id)::int as candidate_token_flows,
      count(distinct wt.id) filter (where wt.normalized_payload->>'providerType' = 'SWAP')::int as candidate_swaps,
      count(distinct wt.id) filter (where wt.normalized_payload->>'providerType' = 'SWAP' and tr.id is null)::int as rejected_candidate_swaps,
      count(distinct tr.id)::int as reconstructed_trades,
      count(distinct tr.id) filter (where tr.execution_price_usd is not null)::int as priced_trades,
      count(distinct ps.id)::int as performance_snapshots
    from tracked_wallets w
    left join wallet_transactions wt on wt.wallet_id = w.id
    left join transaction_token_flows tf on tf.transaction_id = wt.id
    left join tokens tok on tok.id = tf.token_id
    left join wallet_trades tr on tr.transaction_id = wt.id
    left join wallet_performance_snapshots ps on ps.wallet_id = w.id
    where w.address = ${address}
  `;
  const rejectionReasons = await sql`
    select issue.value as reason, count(distinct wt.id)::int as count
    from tracked_wallets w
    join wallet_transactions wt on wt.wallet_id = w.id
    cross join lateral jsonb_array_elements_text(coalesce(wt.normalized_payload->'issues', '[]'::jsonb)) issue(value)
    where w.address = ${address} and wt.normalized_payload->>'providerType' = 'SWAP'
    group by issue.value
    order by count(distinct wt.id) desc, issue.value
  `;
  const pricingStates = await sql`
    select tr.pricing_state, tr.valuation_basis, count(*)::int as trades, min(tr.pricing_confidence_bps)::int as min_confidence_bps, max(tr.pricing_confidence_bps)::int as max_confidence_bps
    from tracked_wallets w join wallet_trades tr on tr.wallet_id = w.id
    where w.address = ${address}
    group by tr.pricing_state, tr.valuation_basis order by trades desc
  `;
  const pricingIssues = await sql`
    select issue.value as issue, count(*)::int as trades
    from tracked_wallets w join wallet_trades tr on tr.wallet_id = w.id
    cross join lateral jsonb_array_elements_text(tr.pricing_issues) issue(value)
    where w.address = ${address} group by issue.value order by trades desc
  `;
  const [flows] = await sql`
    select
      count(*) filter (where tr.wsol_normalized)::int as wsol_normalized,
      count(*) filter (where tr.routed)::int as routed,
      count(*) filter (where tr.rent_excluded_lamports::numeric <> 0)::int as with_ata_rent_excluded,
      count(*) filter (where tr.unattributed_lamports::numeric <> 0)::int as with_unattributed_native_excluded,
      count(*) filter (where tr.tip_lamports::numeric <> 0)::int as with_tips,
      count(*) filter (where tr.consideration_basis = 'EXACT')::int as consideration_exact,
      count(*) filter (where tr.consideration_basis = 'DERIVED')::int as consideration_derived,
      count(*) filter (where tr.consideration_basis = 'AMBIGUOUS')::int as consideration_ambiguous
    from tracked_wallets w join wallet_trades tr on tr.wallet_id = w.id where w.address = ${address}
  `;
  const [accounting] = await sql`
    select
      (select count(*)::int from wallet_inventory_lots l where l.wallet_id = w.id) as lots,
      (select count(*)::int from wallet_realizations r where r.wallet_id = w.id) as realizations,
      (select count(*)::int from wallet_positions p where p.wallet_id = w.id and p.raw_amount::numeric > 0) as open_positions,
      (select count(distinct l.token_id)::int from wallet_inventory_lots l where l.wallet_id = w.id) as tokens_ever_bought,
      (select count(*)::int from wallet_positions p where p.wallet_id = w.id and p.unrealized_pnl_usd is not null) as positions_with_unrealized_pnl
    from tracked_wallets w where w.address = ${address}
  `;
  const snapshots = await sql`
    select ps.window_days, ps.quality, ps.metrics->>'eligible' as eligible, ps.metrics->>'reasons' as reasons, ps.completed_trades, (ps.metrics->>'totalSales')::int as total_sales, (ps.metrics->>'coverageBps')::int as coverage_bps, ps.realized_pnl_usd, ps.metrics->>'scoreEligible' as score_eligible, ps.metrics->>'scoreReasons' as score_reasons
    from tracked_wallets w join wallet_performance_snapshots ps on ps.wallet_id = w.id
    where w.address = ${address} order by ps.window_days
  `;
  console.log(JSON.stringify({ wallet: address, ...counts, pricing_states: pricingStates, pricing_issues: pricingIssues, swap_flow_normalization: flows, accounting, performance_windows: snapshots, rejection_reasons: rejectionReasons }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
