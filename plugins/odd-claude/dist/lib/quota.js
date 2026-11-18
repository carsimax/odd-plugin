// Advisory quota recovery (R35). Classifies the API error that ended a turn and, for recoverable categories,
// arms one advisory line for the next prompt. Same-provider only: Claude Code runs Anthropic models, so the
// advice is `--fallback-model` or `/model`, never another provider. Nothing here blocks or forces anything.
// Classification and cooldown semantics are ported from the upstream agents protocol and model-fallback policy.
import { updateSessionState } from "./state.js";
/** How long a failed model should be avoided: spent quota or credentials last longer than a transient hiccup. */
export const COOLDOWN_MS = { exhausted: 30 * 60_000, transient: 2 * 60_000 };
const EXHAUSTED = new Set(["quota", "auth"]);
const RECOVERABLE = new Set(["quota", "auth", "rate_limit", "provider_unavailable", "timeout", "network"]);
// Claude Code's own StopFailure `error` values (hook matcher values) mapped to categories.
const KNOWN_TYPES = {
    rate_limit: "rate_limit",
    overloaded: "provider_unavailable",
    server_error: "provider_unavailable",
    billing_error: "quota",
    authentication_failed: "auth",
    oauth_org_not_allowed: "auth",
    account_on_hold: "auth",
    verification_required: "auth",
    cloud_credential_error: "auth",
    invalid_request: "invalid_request",
    model_not_found: "invalid_request",
    max_output_tokens: "other",
};
const SCAN_MAX = 4096;
// First match wins: specific causes before the generic statuses they share (quota and context errors often arrive as 429 or 400).
const KEYWORDS = [
    ["context_length", /context.?length|context.?window|maximum context|prompt is too long|too many tokens/i],
    ["quota", /quota|billing|out of budget|usage.?limit|credit balance/i],
    ["auth", /unauthori[sz]ed|forbidden|authenticat|api.?key|permission.?denied/i],
    ["rate_limit", /rate.?limit|too many requests/i],
    ["timeout", /time.?out|timed out|deadline exceeded/i],
    ["network", /network|connection|websocket|ECONN(?:RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|other side closed/i],
    ["provider_unavailable", /overloaded|unavailable|server.?error|internal.?error|server_busy|capacity|high demand/i],
    ["invalid_request", /invalid.?request|bad request/i],
];
// Only a status in a status position: leading ("429: ..."), parenthesized ("Provider (403): ...") or labeled ("status 503", "HTTP 502").
const HTTP_STATUS = /(?:^\s*|\(|\b(?:status(?:\s+code)?|http)\s*:?\s*)([45]\d\d)(?=[\s):,{]|$)/i;
function statusCategory(status) {
    if (status === 401 || status === 403)
        return "auth";
    if (status === 429)
        return "rate_limit";
    if (status === 408 || status === 504)
        return "timeout";
    if (status >= 500)
        return "provider_unavailable";
    return "invalid_request";
}
export function classifyStopFailure(error, details) {
    if (error !== undefined && Object.hasOwn(KNOWN_TYPES, error))
        return KNOWN_TYPES[error];
    const text = `${details ?? ""}`.slice(0, SCAN_MAX);
    if (text === "")
        return "other";
    for (const [category, re] of KEYWORDS)
        if (re.test(text))
            return category;
    const m = HTTP_STATUS.exec(text);
    return m ? statusCategory(Number(m[1])) : "other";
}
/** Advice for recoverable categories only; a request or context problem would fail the same way on another model. */
export function quotaAdvice(category, now) {
    if (!RECOVERABLE.has(category))
        return undefined;
    const cooldownMs = EXHAUSTED.has(category) ? COOLDOWN_MS.exhausted : COOLDOWN_MS.transient;
    const minutes = Math.round(cooldownMs / 60_000);
    const text = [
        `odd-claude quota recovery (advisory): the previous turn ended with a ${category} failure; avoid that model for about ${minutes} min.`,
        "Do not retry automatically. Tell the user they can switch with `/model`, or restart with `claude --fallback-model <model>`",
        "(Anthropic models only: there is no cross-provider fallback). Retry the failed work only when the user asks.",
        "Guidance: cards/quota-recovery.md.",
    ].join(" ");
    return { category, cooldownMs, until: now + cooldownMs, text };
}
/** Records a recoverable failure in the session state and returns it; undefined (nothing stored) otherwise. */
export function recordQuotaFailure(sessionId, input, opts = {}, now = Date.now()) {
    const category = classifyStopFailure(input.error, input.details);
    const advice = quotaAdvice(category, now);
    if (!advice)
        return undefined;
    const stored = { category, until: advice.until, advised: false, text: advice.text };
    updateSessionState(sessionId, (s) => ({ ...s, quotaFailure: stored }), opts);
    return { category, until: advice.until };
}
/** The pending advisory text, once, and only while the cooldown is running. Never throws. */
export function takeQuotaAdvice(sessionId, opts = {}, now = Date.now()) {
    let text;
    try {
        updateSessionState(sessionId, (s) => {
            const f = s.quotaFailure;
            if (!f || f.advised !== false || typeof f.until !== "number" || typeof f.text !== "string" || now >= f.until)
                return s;
            text = f.text;
            return { ...s, quotaFailure: { ...f, advised: true } };
        }, opts);
    }
    catch {
        return undefined;
    }
    return text;
}
