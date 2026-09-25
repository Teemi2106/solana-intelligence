# Wallet scoring

Wallet score is a 0–100 ranking, not a probability. Each persisted score references an immutable formula version, component values, raw inputs, observation quality, and validity interval.

`wallet-score-v1` weights repeatability, sample sufficiency, profitable-token diversity, drawdown, recency, concentration, copyability, and data confidence. It penalizes largest-trade concentration, tiny samples, allocation dependence, poor recency, and uncopyable entries. Absolute profit does not directly dominate. Component values and exact inputs are persisted with the formula version.

Early-access behavior is stored as a separate score and evidence-backed classification. It never implies insider trading, illegality, identity, or likely profit.

Evidence is stored separately with a neutral evidence type, observation timestamp, confidence basis points, optional transaction reference, and structured facts. A single funding observation is insufficient to assert a related/team-linked classification.
