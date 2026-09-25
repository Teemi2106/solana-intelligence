import { aggregatorVenues, quoteAssetKind, SOL_DECIMALS, WRAPPED_SOL_MINT, type QuoteAssetKind } from "./assets";
import type { HistoricalWalletTransaction } from "./ports";

/**
 * Largest gap (lamports) tolerated between the wallet-side native ledger and the exact wSOL counterparty
 * ledger before the SOL leg is declared ambiguous. Observed gaps are account-creation rent the wallet
 * funded for other parties (1.49M-2.04M lamports each).
 */
export const SOL_RAIL_TOLERANCE_LAMPORTS = 10_000_000n;

export interface AssetAmount {
  readonly mint: string;
  readonly rawAmount: bigint;
  readonly decimals: number;
}

/** How the quote amount was obtained. */
export type ConsiderationBasis = "EXACT" | "DERIVED" | "AMBIGUOUS";

export interface ReconstructedLeg {
  /** The traded (non-quote) asset. */
  readonly tokenMint: string;
  readonly tokenDecimals: number;
  readonly side: "BUY" | "SELL";
  readonly rawTokenAmount: bigint;
  readonly spent: AssetAmount | null;
  readonly received: AssetAmount | null;
  /** The consideration asset: what was paid for a BUY, received for a SELL. */
  readonly quote: AssetAmount | null;
  /** null = unknown / long-tail quote asset. */
  readonly quoteKind: QuoteAssetKind | null;
  readonly consideration: ConsiderationBasis;
  /** Wallet-paid network fee (base + priority) plus bundle tips, in lamports. Never part of consideration. */
  readonly feeLamports: bigint;
  readonly networkFeeLamports: bigint;
  readonly tipLamports: bigint;
  /** Net token-account rent locked (+) / recovered (-) by the wallet; never part of consideration. */
  readonly rentExcludedLamports: bigint;
  /** Native lamports that left the wallet outside the exact wSOL rail (rent funded for third parties). */
  readonly unattributedLamports: bigint;
  readonly wsolNormalized: boolean;
  readonly routed: boolean;
  readonly routeAssets: readonly string[];
  readonly venue: string | null;
  readonly issues: readonly string[];
}

export interface ReconstructedSwap {
  readonly kind: "SWAP" | "TRANSFER" | "AMBIGUOUS" | "OTHER";
  readonly legs: readonly ReconstructedLeg[];
  readonly issues: readonly string[];
}

const none = (kind: ReconstructedSwap["kind"], issues: readonly string[]): ReconstructedSwap => ({ kind, legs: [], issues });
const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

interface Delta {
  readonly mint: string;
  readonly amount: bigint;
  readonly decimals: number;
}

const asAmount = (delta: Delta): AssetAmount => ({ mint: delta.mint, rawAmount: absolute(delta.amount), decimals: delta.decimals });

/**
 * Derives the wallet's economic swap from its own asset flows.
 *
 * Only assets the wallet's own accounts gained or lost are considered, so aggregator intermediates
 * (SOL -> A -> B -> TOKEN) net out and never become wallet trades. Rent, tips and network fees are
 * removed from the native ledger and reported separately.
 */
export function reconstructSwap(transaction: HistoricalWalletTransaction): ReconstructedSwap {
  if (!transaction.succeeded) return none("OTHER", ["FAILED_TRANSACTION"]);
  if (transaction.providerType !== "SWAP") {
    return transaction.tokenFlows.length > 0 ? none("TRANSFER", ["TRANSFER_ONLY"]) : none("OTHER", []);
  }

  const nets = new Map<string, { amount: bigint; decimals: number }>();
  for (const flow of transaction.tokenFlows) {
    const current = nets.get(flow.mint) ?? { amount: 0n, decimals: flow.decimals };
    if (current.decimals !== flow.decimals) return none("AMBIGUOUS", ["CONFLICTING_TOKEN_DECIMALS"]);
    current.amount += flow.direction === "IN" ? flow.rawAmount : -flow.rawAmount;
    nets.set(flow.mint, current);
  }
  const visibleWsol = nets.get(WRAPPED_SOL_MINT)?.amount ?? 0n;
  nets.delete(WRAPPED_SOL_MINT);

  // ---- SOL/wSOL leg ---------------------------------------------------------------------------
  // Native SOL and wSOL are one economic asset. Rent, tips and the network fee are removed from the
  // native ledger; temporary wSOL accounts (created and closed in-transaction) net out by themselves.
  const settlement = transaction.settlement;
  const networkFee = transaction.feePayerIsWallet ? transaction.feeLamports : 0n;
  const nativePrincipal = transaction.nativeSolDeltaLamports + networkFee + settlement.walletTokenAccountRentLamports + settlement.tipLamports;
  const walletExposure = nativePrincipal + visibleWsol;
  const issues: string[] = [];
  let solNet = walletExposure;
  let solBasis: ConsiderationBasis = nativePrincipal === 0n ? "EXACT" : "DERIVED";
  let unattributed = 0n;
  let solAmbiguous = false;
  if (settlement.counterpartyWsolDeltaLamports !== null) {
    // Exact wSOL ledger of the counterparties: what the pools/vaults gained is what the wallet paid.
    const rail = -settlement.counterpartyWsolDeltaLamports;
    const gap = walletExposure - rail;
    if (absolute(gap) > SOL_RAIL_TOLERANCE_LAMPORTS) {
      solAmbiguous = true;
      issues.push("SOL_LEDGER_MISMATCH");
    } else {
      solNet = rail;
      solBasis = "EXACT";
      unattributed = gap;
    }
  }
  const wsolNormalized = visibleWsol !== 0n || settlement.counterpartyWsolDeltaLamports !== null;

  const deltas: Delta[] = [...nets].filter(([, value]) => value.amount !== 0n).map(([mint, value]) => ({ mint, amount: value.amount, decimals: value.decimals }));
  if (!solAmbiguous && solNet !== 0n) deltas.push({ mint: WRAPPED_SOL_MINT, amount: solNet, decimals: SOL_DECIMALS });
  if (deltas.length === 0) return none("AMBIGUOUS", [transaction.tokenFlows.length === 0 ? "NO_WALLET_TOKEN_FLOW" : "UNSUPPORTED_SWAP_STRUCTURE", ...issues]);

  const common = {
    feeLamports: networkFee + settlement.tipLamports,
    networkFeeLamports: networkFee,
    tipLamports: settlement.tipLamports,
    rentExcludedLamports: settlement.walletTokenAccountRentLamports,
    unattributedLamports: unattributed,
    wsolNormalized,
    venue: settlement.venue,
  };
  const route = (spent: Delta | null, received: Delta | null) => {
    const touched = new Set([spent?.mint, received?.mint].filter((mint): mint is string => mint !== undefined));
    const solInvolved = touched.has(WRAPPED_SOL_MINT);
    const routeAssets = [...new Set(settlement.movedMints)].filter((mint) => !touched.has(mint) && !(solInvolved && mint === WRAPPED_SOL_MINT)).sort();
    return { routed: (settlement.venue !== null && aggregatorVenues.has(settlement.venue)) || routeAssets.length > 0, routeAssets };
  };

  // One token moved (or the SOL leg is unreliable): keep the trade, leave the consideration unknown.
  if (solAmbiguous || deltas.length === 1) {
    const [only] = deltas;
    if (!only || deltas.length !== 1) return none("AMBIGUOUS", ["AMBIGUOUS_MULTI_ASSET_FLOW", ...issues]);
    if (only.mint === WRAPPED_SOL_MINT) return none("AMBIGUOUS", ["NO_TOKEN_LEG", ...issues]);
    const buy = only.amount > 0n;
    const legIssues = [...issues, "CONSIDERATION_NOT_ESTABLISHED"];
    return {
      kind: "SWAP",
      issues: legIssues,
      legs: [{
        ...common, ...route(buy ? null : only, buy ? only : null),
        tokenMint: only.mint, tokenDecimals: only.decimals, side: buy ? "BUY" : "SELL", rawTokenAmount: absolute(only.amount),
        spent: buy ? null : asAmount(only), received: buy ? asAmount(only) : null, quote: null, quoteKind: null,
        consideration: "AMBIGUOUS", issues: legIssues,
      }],
    };
  }

  const negative = deltas.filter((delta) => delta.amount < 0n);
  const positive = deltas.filter((delta) => delta.amount > 0n);
  const [spent] = negative;
  const [received] = positive;
  if (negative.length !== 1 || positive.length !== 1 || !spent || !received) return none("AMBIGUOUS", ["AMBIGUOUS_MULTI_ASSET_FLOW", ...issues]);
  const spentKind = quoteAssetKind(spent.mint, spent.decimals);
  const receivedKind = quoteAssetKind(received.mint, received.decimals);
  if (spentKind !== null && receivedKind !== null) return none("SWAP", ["QUOTE_TO_QUOTE_SWAP"]);

  const flow = route(spent, received);
  const basisOf = (mint: string): ConsiderationBasis => (mint === WRAPPED_SOL_MINT ? solBasis : "EXACT");
  const leg = (token: Delta, quote: Delta, side: "BUY" | "SELL", quoteKind: QuoteAssetKind | null, carriesFees: boolean): ReconstructedLeg => ({
    ...common,
    ...(carriesFees ? {} : { feeLamports: 0n, networkFeeLamports: 0n, tipLamports: 0n }),
    ...flow,
    tokenMint: token.mint, tokenDecimals: token.decimals, side, rawTokenAmount: absolute(token.amount),
    spent: asAmount(spent), received: asAmount(received), quote: asAmount(quote), quoteKind,
    consideration: basisOf(quote.mint), issues,
  });
  if (spentKind !== null) return { kind: "SWAP", issues, legs: [leg(received, spent, "BUY", spentKind, true)] };
  if (receivedKind !== null) return { kind: "SWAP", issues, legs: [leg(spent, received, "SELL", receivedKind, true)] };
  // Token-for-token swap: the wallet really disposed of one asset and acquired another.
  return { kind: "SWAP", issues: [...issues, "UNKNOWN_QUOTE_ASSET"], legs: [leg(spent, received, "SELL", null, true), leg(received, spent, "BUY", null, false)] };
}
