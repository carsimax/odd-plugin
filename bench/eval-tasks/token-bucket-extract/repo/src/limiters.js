export class ApiLimiter {
  constructor({ perMinute, now = Date.now }) {
    this.capacity = perMinute;
    this.rate = perMinute / 60000;
    this.now = now;
    this.buckets = new Map();
  }

  allow(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.last) * this.rate);
    b.last = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }
}

export class LoginLimiter {
  constructor({ maxAttempts, windowMs, now = Date.now }) {
    this.capacity = maxAttempts;
    this.rate = maxAttempts / windowMs;
    this.now = now;
    this.users = new Map();
  }

  attempt(user) {
    const t = this.now();
    let u = this.users.get(user);
    if (!u) {
      u = { tokens: this.capacity, last: t };
      this.users.set(user, u);
    }
    u.tokens = Math.min(this.capacity, u.tokens + (t - u.last) * this.rate);
    u.last = t;
    if (u.tokens >= 1) {
      u.tokens -= 1;
      return { ok: true, remaining: Math.floor(u.tokens) };
    }
    return { ok: false, remaining: 0, retryAfterMs: Math.ceil((1 - u.tokens) / this.rate) };
  }

  reset(user) {
    this.users.delete(user);
  }
}
