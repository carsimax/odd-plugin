# limiters

Two rate limiters with an injectable clock (`now` returns milliseconds).

- `ApiLimiter({ perMinute, now })`: `allow(key)` returns `true` or `false`; each key has its own allowance.
- `LoginLimiter({ maxAttempts, windowMs, now })`: `attempt(user)` returns `{ ok, remaining }` plus `retryAfterMs` when refused; `reset(user)` forgets a user.

Run the tests with `npm test`.
