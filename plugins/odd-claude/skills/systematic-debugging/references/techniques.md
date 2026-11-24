# Debugging techniques

Load when localizing a failure or hardening after a fix.

## Backward tracing

The place a bad value shows up is rarely where it was made. Walk up the call chain: what received the value, who passed it, who built it. Stop at the first place the value is already wrong; fix there. If the chain is too long to read, add a temporary stack capture at the suspect sink, print it once, and remove it afterwards.

```ts
function writeReport(dir: string) {
  if (!dir) console.error("writeReport: empty dir", new Error().stack); // temporary
}
```

## Boundary instrumentation

For a pipeline of components (CLI, service, store; CI step, script, tool), log what enters and what leaves each boundary in one run. The first boundary whose output is wrong names the component to investigate. Log presence and shape of secrets, never their values.

```sh
echo "in: $INPUT_FILE" >&2; run_step "$INPUT_FILE" | tee /dev/stderr | next_step
```

## Bisection

- Regression with a known good commit: `git bisect start <bad> <good>`, then `git bisect run <test command>`; the command must exit non-zero only for the failure being hunted.
- No good commit or not a code change: halve the input, the config, or the list of enabled features until the smallest failing set remains.
- Flaky: run the case in a loop (for example 50 times) to measure the failure rate before and after any change.

## Defense in depth

After the root cause is fixed, make the same bug class impossible or loud at other layers: validate at the entry point, enforce the invariant where the data is used, fail fast with a message naming the bad value, and keep a guard where the environment can differ (tests vs production). One layer is a fix; several layers are a guarantee. Add each guard only if it can be covered by a test.

## Condition-based waiting

A fixed sleep guesses a duration; a condition checks the state. Poll the real condition with a short interval and an overall timeout, and fail with a message saying what was awaited.

```ts
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
```

A sleep is acceptable only when elapsed time is the behavior under test (debounce, retry backoff); name the reason in a comment.
