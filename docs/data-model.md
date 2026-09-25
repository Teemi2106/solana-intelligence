# Data model

## Core groups

| Group | Tables | Purpose |
|---|---|---|
| Wallet identity | `tracked_wallets`, `wallet_labels` | Public addresses, lifecycle, operator labels |
| Time-versioned intelligence | `wallet_scores`, `wallet_score_versions`, `wallet_classifications`, `wallet_performance_snapshots` | Reproducible as-of scoring without look-ahead |
| Relationships | `wallet_relationships` | Evidence-bearing, confidence-scored observations; never asserted ownership |
| Chain facts | `provider_events`, `wallet_transactions`, `wallet_trades`, `tokens` | Idempotent raw summaries and normalized effects |
| Token state | `token_market_snapshots`, `token_risk_snapshots` | Point-in-time market and observable risk facts |
| Signals | `signals`, `signal_wallets`, `signal_snapshots`, `signal_score_versions` | Immutable detection state and exact contributing evidence |
| Research | `signal_outcomes` | Due horizons and post-detection observations |
| Delivery | `alerts`, `alert_deliveries` | Persist-before-send, deduplicated notification lifecycle |
| Operations | `processing_failures`, `system_health`, `audit_logs` | Recovery, readiness, and privileged-action traceability |
| Historical ingestion | `wallet_ingestion_runs`, `wallet_ingestion_checkpoints` | Resumable page cursors, progress, and terminal state |
| Accounting | `transaction_token_flows`, `wallet_inventory_lots`, `wallet_realizations`, `wallet_positions` | Normalized flows, FIFO provenance, realized results, and exposure |
| Classification evidence | `wallet_classification_evidence` | Timestamped neutral evidence supporting classification |

## Numerical correctness

- Raw SOL/token quantities are base-unit `bigint` values in TypeScript and scale-zero `NUMERIC(78,0)` in PostgreSQL.
- Token decimals travel with the raw amount and are range constrained.
- USD values use `NUMERIC(38,18)` and cross boundaries as decimal strings.
- Ratios and returns use `NUMERIC(20,10)`. Basis points are integers where suitable.
- `number` is permitted for bounded ranks, counts, durations, and basis points—not money.
- Conversion, allocation, and PnL use deterministic decimal/integer operations with an explicit rounding policy.

Display formatting never becomes a source value.

## PnL methodology

Phase 2 uses chronological lot accounting. A buy creates cost-basis lots including attributable fees; a partial sell consumes lots under one documented policy (initially FIFO) and realizes proceeds minus consumed basis and sell fees. Transfers do not become purchases or realized sales. Received allocations retain an unknown or separately sourced basis and are reported with data quality. Missing prices exclude the affected USD metric rather than being treated as zero. Realized and unrealized PnL remain separate at storage and presentation layers.

Sell proceeds are allocated across consumed FIFO lots in proportion to raw quantity. Buy fees increase basis; sell fees reduce proceeds. Partial disposal reduces remaining raw quantity and basis proportionally using 50-digit decimal arithmetic and half-even rounding. Failed transactions never enter accounting. Routed intermediate assets are netted; multiple non-base residuals are ambiguous.

Unrealized PnL exists only when inventory basis is known and a sufficiently fresh market price exists. Otherwise the value is `NULL` and the reason lowers data quality.

## Anti-lookahead

Scores and classifications have `valid_from`/`valid_to`. Signal contributors reference the exact score and classification records used. Market and risk snapshots carry observation timestamps. Historical evaluation selects only records observed at or before the simulated detection time. Later enrichment creates new records; it does not rewrite the signal snapshot.
