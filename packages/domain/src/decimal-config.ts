import { Decimal } from "decimal.js";

/** Single place where financial decimal precision is configured; import for its side effect before any Decimal use. */
Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -30, toExpPos: 50 });

export { Decimal };
