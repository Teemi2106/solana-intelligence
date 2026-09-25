/** Serializes upstream calls so consecutive request starts are at least `minIntervalMs` apart. */
export class MinIntervalLimiter {
  private nextAllowedAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: (milliseconds: number) => Promise<void>,
    private readonly now: () => number,
  ) {}

  async acquire(): Promise<void> {
    const current = this.now();
    const wait = Math.max(0, this.nextAllowedAt - current);
    this.nextAllowedAt = current + wait + this.minIntervalMs;
    if (wait > 0) await this.sleep(wait);
  }
}
