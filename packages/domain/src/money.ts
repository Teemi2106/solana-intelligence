export class DecimalAmount {
  private constructor(
    readonly coefficient: bigint,
    readonly scale: number,
  ) {}

  static fromBaseUnits(value: bigint, decimals: number): DecimalAmount {
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 30) {
      throw new RangeError("decimals must be an integer between 0 and 30");
    }
    return new DecimalAmount(value, decimals);
  }

  add(other: DecimalAmount): DecimalAmount {
    this.assertSameScale(other);
    return new DecimalAmount(this.coefficient + other.coefficient, this.scale);
  }

  subtract(other: DecimalAmount): DecimalAmount {
    this.assertSameScale(other);
    return new DecimalAmount(this.coefficient - other.coefficient, this.scale);
  }

  toString(): string {
    if (this.scale === 0) return this.coefficient.toString();
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient)
      .toString()
      .padStart(this.scale + 1, "0");
    const whole = digits.slice(0, -this.scale);
    const fraction = digits.slice(-this.scale);
    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }

  private assertSameScale(other: DecimalAmount): void {
    if (this.scale !== other.scale) throw new Error("amount scales do not match");
  }
}
