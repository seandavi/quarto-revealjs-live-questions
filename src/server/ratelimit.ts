/**
 * Token bucket rate limiter. Pure: the caller passes the current time, so it
 * runs identically on Node and Workers and is trivially testable.
 */

export interface BucketConfig {
  /** Maximum tokens (messages allowed in a burst). */
  burst: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

/** Audience sockets: burst 20, refill 5 per second (SPEC.md). */
export const AUDIENCE_LIMIT: BucketConfig = { burst: 20, refillPerSecond: 5 };

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly config: BucketConfig,
    now: number,
  ) {
    this.tokens = config.burst;
    this.last = now;
  }

  /** Spend one token if available. `now` is in milliseconds. */
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.config.burst, this.tokens + elapsed * this.config.refillPerSecond);
    this.last = Math.max(this.last, now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
