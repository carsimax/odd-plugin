# Temporary verifier quota recovery

Parent only: load after an identified verifier quota failure when the human explicitly requests the missing verification.

A temporary verifier quota failure with no verdict still ends the automatic cycle. After the human reports restored availability and explicitly requests the missing verification, allow one new bounded attempt for the same candidate. Preserve the failed attempt and still-valid passed checks; do not replay passed suites. Confirm no child is active or uncertain (check background agents before relaunching). This is not an automatic retry, provider/model fallback, or reset of correction budgets. Consent, denials, explicit one-run/no-retry limits and terminal outcomes remain binding; failure never counts as approval.

## Claude Code notes (advisory)

- Cross-provider fallback is not possible: Claude Code runs Anthropic models only. Recovery means another Anthropic model, never another provider.
- The human can start with `claude --fallback-model <model>` (used when the primary model is overloaded) or switch mid-session with `/model`. Suggest these; never switch or relaunch on your own.
- The `StopFailure` hook classifies the API error that ended a turn (rate limit, overload, quota/billing, auth, timeout, network). Claude Code ignores its output, so it only logs and arms one advisory line for the next prompt, shown while the cooldown runs: about 30 min for quota/billing/auth, about 2 min for the transient ones. Request or context-length errors get no advice: another model would fail the same way.
- Cooldown semantics: avoid the failed model until the cooldown ends. The advisory never retries, never blocks and never counts as approval.
