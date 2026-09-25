import { describe, expect, it } from "vitest";
import { DecimalAmount } from "./money";

describe("DecimalAmount", () => {
  it("preserves base-unit precision beyond Number.MAX_SAFE_INTEGER", () => {
    const amount = DecimalAmount.fromBaseUnits(90_071_992_547_409_931n, 6);
    expect(amount.toString()).toBe("90071992547.409931");
  });

  it("adds values without floating-point rounding", () => {
    const a = DecimalAmount.fromBaseUnits(1n, 1);
    const b = DecimalAmount.fromBaseUnits(2n, 1);
    expect(a.add(b).toString()).toBe("0.3");
  });
});
