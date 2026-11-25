import { TokenBucket } from "./token-bucket.js";

export class ApiLimiter {
  constructor({ perMinute, now = Date.now }) {
    this.perMinute = perMinute;
    this.now = now;
    this.buckets = new Map();
  }

  allow(key) {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket({ capacity: this.perMinute, refillPerMs: this.perMinute / 60000, now: this.now });
      this.buckets.set(key, b);
    }
    return b.tryTake();
  }
}

export class LoginLimiter {
  constructor({ maxAttempts, windowMs, now = Date.now }) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.now = now;
    this.users = new Map();
  }

  attempt(user) {
    let b = this.users.get(user);
    if (!b) {
      b = new TokenBucket({ capacity: this.maxAttempts, refillPerMs: this.maxAttempts / this.windowMs, now: this.now });
      this.users.set(user, b);
    }
    if (b.tryTake()) return { ok: true, remaining: b.available() };
    return { ok: false, remaining: 0, retryAfterMs: b.msUntil(1) };
  }

  reset(user) {
    this.users.delete(user);
  }
}
