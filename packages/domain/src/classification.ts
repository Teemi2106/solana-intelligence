export const classificationEvidenceTypes = ["PRE_LAUNCH_RECIPIENT", "EARLY_ALLOCATION_PATTERN", "DEPLOYER_LINKED_TRANSFER", "PRE_LIQUIDITY_HOLDER", "EARLY_LIQUIDITY_ENTRY", "RELATED_FUNDING_PATTERN", "NON_COPYABLE_ENTRY", "HIGH_ALLOCATION_DEPENDENCE"] as const;
export type ClassificationEvidenceType = typeof classificationEvidenceTypes[number];

export interface ClassificationEvidence {
  readonly type: ClassificationEvidenceType;
  readonly confidenceBps: number;
  readonly observedAt: Date;
  readonly facts: Readonly<Record<string, unknown>>;
}

export function classifyWallet(evidence: readonly ClassificationEvidence[]): { classification: "COPYABLE_SMART_MONEY" | "EARLY_ACCESS_ALLOCATION_PATTERN" | "RELATED_TEAM_LINKED" | "UNKNOWN_INSUFFICIENT_EVIDENCE"; earlyAccessScore: number; confidenceBps: number } {
  const earlyTypes = new Set<ClassificationEvidenceType>(["PRE_LAUNCH_RECIPIENT", "EARLY_ALLOCATION_PATTERN", "DEPLOYER_LINKED_TRANSFER", "PRE_LIQUIDITY_HOLDER", "EARLY_LIQUIDITY_ENTRY", "HIGH_ALLOCATION_DEPENDENCE"]);
  const related = evidence.filter((item) => item.type === "RELATED_FUNDING_PATTERN");
  const early = evidence.filter((item) => earlyTypes.has(item.type));
  const nonCopyable = evidence.filter((item) => item.type === "NON_COPYABLE_ENTRY");
  const confidenceBps = evidence.length === 0 ? 0 : Math.round(evidence.reduce((sum, item) => sum + item.confidenceBps, 0) / evidence.length);
  if (related.length >= 2) return { classification: "RELATED_TEAM_LINKED", earlyAccessScore: 0, confidenceBps };
  if (early.length >= 2 || nonCopyable.length >= 3) return { classification: "EARLY_ACCESS_ALLOCATION_PATTERN", earlyAccessScore: Math.min(100, early.length * 20 + nonCopyable.length * 10), confidenceBps };
  return { classification: "UNKNOWN_INSUFFICIENT_EVIDENCE", earlyAccessScore: early.length * 10, confidenceBps };
}
