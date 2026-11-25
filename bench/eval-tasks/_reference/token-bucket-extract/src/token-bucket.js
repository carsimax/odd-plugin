export class TokenBucket {
  constructor({ capacity, refillPerMs, now = Date.now }) {
    this.capacity = capacity;
    this.rate = refillPerMs;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  #refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.rate);
    this.last = t;
  }

  tryTake(n = 1) {
    this.#refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  available() {
    this.#refill();
    return Math.floor(this.tokens);
  }

  msUntil(n = 1) {
    this.#refill();
    if (this.tokens >= n) return 0;
    return Math.ceil((n - this.tokens) / this.rate);
  }
}
