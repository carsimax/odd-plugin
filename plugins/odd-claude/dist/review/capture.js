// Capture + correction (U6): admit reviewer results into the authority and drive the review to its verdict.
//
// Flow: lens results (one per selected lens, bound to their artifact subject) -> when every lens is admitted the
// review settles: nothing severe blocks -> approved (one-shot token returned once); candidate-caused severe findings ->
// correction_required with the frozen ledger; severe findings of unknown causality or insufficient evidence -> escalated.
// An optional refuter batch can refute blocking findings before the correction is opened (`awaitRefuter`). The single
// correction is planned (`planCorrection`), edited by the user/agent, then checked against its budget and scope
// (`beginCorrectionValidation`) and judged by a targeted validator (`captureValidatorResult`): approved or escalated.
// Every admission is ONE store CAS (`updateState`), so concurrent lens captures admit each lens exactly once.
//
// Results are validated against embedded copies of the provider-mirror v1.6.0 schemas (ids renamed for odd-claude); a
// spec pins them to the vendored corpus. Reviewers echo a subject (lens) or a request hash (refuter, validator); any
// mismatch is `binding_drift` and nothing is admitted.
import { domainHash } from "./canonical.js";
import { artifactSubjectFor, artifactSubjectProblems, findingPath, manifestFor, refuterRequestHash, targetedValidationRequestHash, treeDiffPaths, } from "./artifact.js";
import { hasRole, lensesPending } from "./lineage.js";
import { validate } from "./schema.js";
import { SnapshotError, countChangedLines } from "./snapshot.js";
import { LENSES, MAX_ADMITTED_ROLE_RESULTS, admitLensResult, admitRefuterResult, admitValidatorResult, approve, beginValidation, blockingFindingIds, escalate, findingIdPrefixForLens, inconclusiveFindingIds, requireCorrection, } from "./state.js";
import { StoreConcurrentUpdateError, StoreTransitionRefusedError, readState, updateState } from "./store.js";
// Embedded copies of the provider-mirror v1.6.0 result schemas (only $id and title renamed); capture.spec.ts pins
// them to the vendored corpus under test-fixtures/review/vendor/provider-mirror, which is not shipped with the plugin.
const LENS_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://odd-claude.dev/schema/review/reviewer/v1",
    "title": "odd-claude reviewer result",
    "type": "object",
    "additionalProperties": false,
    "required": [
        "subject_hash",
        "inspection",
        "findings",
        "evidence"
    ],
    "properties": {
        "subject_hash": {
            "type": "string",
            "pattern": "^sha256:[0-9a-f]{64}$"
        },
        "inspection": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "status",
                "paths"
            ],
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "status": {
                                "const": "unavailable"
                            }
                        },
                        "required": [
                            "status"
                        ]
                    },
                    "then": {
                        "required": [
                            "reason"
                        ]
                    }
                }
            ],
            "properties": {
                "status": {
                    "type": "string",
                    "enum": [
                        "completed",
                        "unavailable"
                    ],
                    "description": "\"completed\" asserts every changed_path_manifest path was actually inspected. \"unavailable\" asserts the candidate could not be inspected at all and requires a non-empty reason; this is the typed admission-completeness signal; evidence prose is not a substitute for it."
                },
                "paths": {
                    "type": "array",
                    "description": "Complete unique unordered set of every changed_path_manifest.path when status is \"completed\"; empty when status is \"unavailable\".",
                    "uniqueItems": true,
                    "items": {
                        "type": "string",
                        "minLength": 1
                    }
                },
                "reason": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Required and non-empty only when status is \"unavailable\": why the candidate could not be inspected."
                }
            }
        },
        "lens": {
            "type": "string",
            "description": "Optional selected lens binding. Omission canonicalizes to the selected subject lens.",
            "enum": [
                "risk",
                "resilience",
                "readability",
                "reliability",
                "review-risk",
                "review-resilience",
                "review-readability",
                "review-reliability"
            ]
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                    "location",
                    "severity",
                    "claim",
                    "proof_refs"
                ],
                "allOf": [
                    {
                        "if": {
                            "properties": {
                                "severity": {
                                    "enum": [
                                        "BLOCKER",
                                        "CRITICAL"
                                    ]
                                }
                            },
                            "required": [
                                "severity"
                            ]
                        },
                        "then": {
                            "required": [
                                "evidence_class",
                                "causal_disposition"
                            ]
                        }
                    }
                ],
                "properties": {
                    "id": {
                        "type": "string",
                        "pattern": "^R[1-4]-[A-Za-z0-9][A-Za-z0-9._-]*$",
                        "description": "Optional explicit ID; omit it to receive a native-assigned ID. When present it must carry the prefix bound to the selected lens, not the selection order: review-risk=R1-, review-readability=R2-, review-reliability=R3-, review-resilience=R4-."
                    },
                    "lens": {
                        "type": "string",
                        "enum": [
                            "risk",
                            "resilience",
                            "readability",
                            "reliability",
                            "review-risk",
                            "review-resilience",
                            "review-readability",
                            "review-reliability"
                        ]
                    },
                    "location": {
                        "type": "string",
                        "description": "One canonical repository-relative path:line or inclusive path:start-end span.",
                        "pattern": "^.+:[1-9][0-9]*(?:-[1-9][0-9]*)?$"
                    },
                    "severity": {
                        "type": "string",
                        "enum": [
                            "BLOCKER",
                            "CRITICAL",
                            "WARNING",
                            "SUGGESTION"
                        ]
                    },
                    "claim": {
                        "type": "string",
                        "minLength": 1
                    },
                    "proof_refs": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "string",
                            "pattern": "\\S",
                            "not": {
                                "pattern": "^\\s*(?:[nN]/[aA]|[nN][aA]|[nN][oO][nN][eE]|[tT][oO][dD][oO]|[tT][bB][dD]|[pP][aA][sS][sS]|[pP][aA][sS][sS][eE][dD]|[sS][uU][cC][cC][eE][sS][sS]|[pP][lL][aA][cC][eE][hH][oO][lL][dD][eE][rR])\\s*$"
                            }
                        }
                    },
                    "evidence_class": {
                        "type": "string",
                        "enum": [
                            "deterministic",
                            "inferential",
                            "insufficient"
                        ]
                    },
                    "causal_disposition": {
                        "type": "string",
                        "enum": [
                            "introduced",
                            "behavior-activated",
                            "worsened",
                            "pre-existing",
                            "base-only",
                            "unknown"
                        ]
                    }
                }
            }
        },
        "evidence": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "string",
                "pattern": "\\S",
                "not": {
                    "pattern": "^\\s*(?:[nN]/[aA]|[nN][aA]|[nN][oO][nN][eE]|[tT][oO][dD][oO]|[tT][bB][dD]|[pP][aA][sS][sS]|[pP][aA][sS][sS][eE][dD]|[sS][uU][cC][cC][eE][sS][sS]|[pP][lL][aA][cC][eE][hH][oO][lL][dD][eE][rR])\\s*$"
                }
            }
        }
    },
    "examples": [
        {
            "subject_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "inspection": {
                "status": "completed",
                "paths": [
                    "internal/example.go"
                ]
            },
            "findings": [],
            "evidence": [
                "reviewed the complete candidate scope"
            ]
        },
        {
            "subject_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "inspection": {
                "status": "unavailable",
                "paths": [],
                "reason": "the immutable inspection command timed out before any path could be read"
            },
            "findings": [],
            "evidence": [
                "inspection was unavailable; see inspection.reason"
            ]
        }
    ]
};
const REFUTER_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://odd-claude.dev/schema/review/refuter/v1",
    "title": "odd-claude refuter result",
    "type": "object",
    "additionalProperties": false,
    "required": [
        "refuter_request_hash",
        "results"
    ],
    "properties": {
        "refuter_request_hash": {
            "$ref": "#/$defs/sha256"
        },
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                    "finding_id",
                    "outcome",
                    "proof_refs"
                ],
                "properties": {
                    "finding_id": {
                        "type": "string"
                    },
                    "outcome": {
                        "type": "string",
                        "enum": [
                            "corroborated",
                            "refuted",
                            "inconclusive"
                        ]
                    },
                    "proof_refs": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "string",
                            "pattern": "\\S"
                        }
                    }
                }
            }
        }
    },
    "$defs": {
        "sha256": {
            "type": "string",
            "pattern": "^sha256:[0-9a-f]{64}$"
        }
    },
    "examples": [
        {
            "refuter_request_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "results": []
        }
    ]
};
const VALIDATOR_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://odd-claude.dev/schema/review/validator/v1",
    "title": "odd-claude targeted validator result",
    "type": "object",
    "additionalProperties": false,
    "required": [
        "targeted_validation_request_hash",
        "correction_target_identity",
        "original_criteria",
        "correction_regression",
        "follow_ups"
    ],
    "properties": {
        "targeted_validation_request_hash": {
            "$ref": "#/$defs/sha256"
        },
        "correction_target_identity": {
            "$ref": "#/$defs/sha256"
        },
        "original_criteria": {
            "$ref": "#/$defs/check"
        },
        "correction_regression": {
            "$ref": "#/$defs/check"
        },
        "follow_ups": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                    "observation",
                    "proof_refs"
                ],
                "properties": {
                    "observation": {
                        "type": "string"
                    },
                    "proof_refs": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "string",
                            "pattern": "\\S"
                        }
                    }
                }
            }
        }
    },
    "allOf": [
        {
            "if": {
                "properties": {
                    "correction_regression": {
                        "type": "object",
                        "properties": {
                            "passed": {
                                "const": false
                            }
                        },
                        "required": [
                            "passed"
                        ]
                    }
                },
                "required": [
                    "correction_regression"
                ]
            },
            "then": {
                "properties": {
                    "correction_regression": {
                        "type": "object",
                        "properties": {
                            "regressions": {
                                "minItems": 1
                            }
                        },
                        "required": [
                            "regressions"
                        ]
                    }
                }
            }
        }
    ],
    "$defs": {
        "sha256": {
            "type": "string",
            "pattern": "^sha256:[0-9a-f]{64}$"
        },
        "check": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "passed",
                "evidence"
            ],
            "properties": {
                "passed": {
                    "type": "boolean",
                    "description": "true means the named check passed; false means the named check failed."
                },
                "evidence": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "string"
                    }
                },
                "regressions": {
                    "type": "array",
                    "items": {
                        "$ref": "#/$defs/regression"
                    },
                    "description": "Required with at least one entry when this is correction_regression and passed is false: one entry per observed regression, omitted or empty otherwise."
                },
                "inspection": {
                    "$ref": "#/$defs/inspection"
                }
            },
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "inspection": {
                                "type": "object",
                                "properties": {
                                    "status": {
                                        "const": "unavailable"
                                    }
                                },
                                "required": [
                                    "status"
                                ]
                            }
                        },
                        "required": [
                            "inspection"
                        ]
                    },
                    "then": {
                        "properties": {
                            "inspection": {
                                "type": "object",
                                "required": [
                                    "reason"
                                ]
                            }
                        }
                    }
                }
            ]
        },
        "inspection": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "status"
            ],
            "properties": {
                "status": {
                    "type": "string",
                    "enum": [
                        "completed",
                        "unavailable"
                    ],
                    "description": "completed means this check's verdict came from actually reading the frozen candidate trees. unavailable means it did not, and this check produced no verdict."
                },
                "reason": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Required when status is unavailable: why the frozen candidate trees could not be read."
                }
            },
            "description": "Optional. Omit this field entirely when inspection completed normally -- every check that predates this field already assumed that default. Never infer unavailable from evidence wording; only this typed field marks a check inconclusive."
        },
        "regression": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "location",
                "claim",
                "proof_refs"
            ],
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Optional explicit ID; omit it to receive a native-assigned ID."
                },
                "location": {
                    "type": "string",
                    "description": "One canonical repository-relative path:line or inclusive path:start-end span.",
                    "pattern": "^.+:[1-9][0-9]*(?:-[1-9][0-9]*)?$"
                },
                "claim": {
                    "type": "string",
                    "minLength": 1
                },
                "proof_refs": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "string",
                        "pattern": "\\S"
                    }
                }
            }
        }
    },
    "examples": [
        {
            "targeted_validation_request_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "correction_target_identity": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "original_criteria": {
                "passed": true,
                "evidence": [
                    "acceptance test passed"
                ]
            },
            "correction_regression": {
                "passed": true,
                "evidence": [
                    "regression test passed"
                ]
            },
            "follow_ups": []
        }
    ]
};
const LENS = LENS_SCHEMA;
const REFUTER = REFUTER_SCHEMA;
const VALIDATOR = VALIDATOR_SCHEMA;
function schemaErrors(schema, value, name) {
    return validate(schema, value, {
        base: `embedded://${name}`,
        load: () => {
            throw new Error("embedded schemas have no external references");
        },
    });
}
/** Errors of a lens / refuter / targeted-validator result against the embedded provider-mirror schema. */
export const resultSchemaErrors = {
    lens: (value) => schemaErrors(LENS, value, "lens"),
    refuter: (value) => schemaErrors(REFUTER, value, "refuter"),
    validator: (value) => schemaErrors(VALIDATOR, value, "targeted-validator"),
};
export const EMBEDDED_RESULT_SCHEMAS = { lens: LENS_SCHEMA, refuter: REFUTER_SCHEMA, validator: VALIDATOR_SCHEMA };
const refusal = (code, message, extra = {}) => ({
    ok: false,
    code,
    message,
    ...extra,
});
const clock = (opts) => (opts.now ?? (() => new Date().toISOString()))();
function nextOf(record) {
    switch (record.state) {
        case "approved":
            return "approved";
        case "correction_required":
            return "correction_required";
        case "validating":
            return "validating";
        case "escalated":
        case "invalidated":
            return "escalated";
        default:
            return "collect";
    }
}
function statusOf(record, extra = {}) {
    const status = {
        ok: true,
        state: record.state,
        next: nextOf(record),
        revision: record.revision,
        record,
        pending_lenses: lensesPending(record),
    };
    if (extra.ackToken !== undefined)
        status.ackToken = extra.ackToken;
    if (record.state === "reviewing" && status.pending_lenses.length === 0) {
        const blocking = blockingFindingIds(record);
        if (blocking.length > 0)
            status.pending_refutation = blocking;
    }
    return status;
}
/** Maps the store's typed failures to capture refusals; anything else (not found, corrupt, I/O) propagates. */
async function commit(run) {
    try {
        return await run();
    }
    catch (e) {
        if (e instanceof StoreConcurrentUpdateError) {
            return refusal("concurrent_update", e.message, { currentRevision: e.currentRevision });
        }
        if (e instanceof StoreTransitionRefusedError)
            return refusal(e.refusal.code, e.refusal.message);
        throw e;
    }
}
/**
 * Settles a fully reviewed record. Inconclusive severe findings escalate; nothing blocking approves (follow-ups do not
 * block); blocking findings open the single correction, unless the caller waits for an optional refuter batch.
 */
function settleReview(record, opts) {
    const inconclusive = inconclusiveFindingIds(record);
    if (inconclusive.length > 0) {
        return escalate(record, { now: opts.now, reason: `severe findings with unknown causality or insufficient evidence: ${inconclusive.join(", ")}` });
    }
    const blocking = blockingFindingIds(record);
    if (blocking.length === 0)
        return approve(record, { now: opts.now, randomToken: opts.randomToken });
    if (opts.awaitRefuter && !hasRole(record, "refuter"))
        return { ok: true, record };
    const correction = requireCorrection(record, { now: opts.now, fixFindingIds: blocking });
    if (correction.ok)
        return correction;
    return escalate(record, { now: opts.now, reason: correction.refusal.message });
}
const normalizeLens = (lens) => (typeof lens === "string" ? lens.replace(/^review-/, "") : "");
function mapFindings(lens, result) {
    const prefix = findingIdPrefixForLens(lens);
    const explicit = new Set(result.findings.map((f) => f.id).filter((id) => typeof id === "string"));
    let counter = 0;
    const out = [];
    for (const f of result.findings) {
        if (f.lens !== undefined && normalizeLens(f.lens) !== lens)
            return refusal("binding_drift", `a finding is bound to lens ${f.lens}, not ${lens}`);
        let id = f.id;
        if (id === undefined) {
            do
                id = `${prefix}${++counter}`;
            while (explicit.has(id));
            explicit.add(id);
        }
        out.push({
            id,
            lens,
            severity: f.severity,
            location: f.location,
            claim: f.claim,
            ...(f.evidence_class !== undefined ? { evidence_class: f.evidence_class } : {}),
            ...(f.causal_disposition !== undefined ? { causal_disposition: f.causal_disposition } : {}),
        });
    }
    return out;
}
export async function captureLensResult(commonDir, lineage, expectedRevision, input, opts = {}) {
    const current = readState(commonDir, lineage);
    if (current.revision !== expectedRevision) {
        return refusal("concurrent_update", "the review changed since the expected revision", { currentRevision: current.revision });
    }
    if (current.state !== "reviewing")
        return refusal("illegal_state", `cannot capture a lens result from ${current.state}`);
    const lens = normalizeLens(input?.lens);
    if (!LENSES.includes(lens) || !current.selected_lenses.includes(lens))
        return refusal("invalid_input", `lens ${String(input?.lens)} is not selected for this review`);
    if (current.admitted_role_results.some((e) => e.role === "lens" && e.lens === lens))
        return refusal("lens_already_admitted", `lens ${lens} already has an admitted result`);
    if (current.admitted_role_results.length >= MAX_ADMITTED_ROLE_RESULTS)
        return refusal("capacity_exceeded", "admitted role results are full");
    const errors = resultSchemaErrors.lens(input.result);
    if (errors.length > 0)
        return refusal("schema_invalid", "the lens result does not match the lens schema", { errors });
    const result = input.result;
    if (result.lens !== undefined && normalizeLens(result.lens) !== lens)
        return refusal("binding_drift", `the result is bound to lens ${result.lens}, not ${lens}`);
    const problems = artifactSubjectProblems(input?.subject);
    if (problems.length > 0)
        return refusal("binding_drift", "the presented artifact subject is malformed", { errors: problems });
    let manifest;
    try {
        manifest = manifestFor(commonDir, current);
    }
    catch (e) {
        if (e instanceof SnapshotError)
            return refusal("snapshot_unavailable", `the frozen trees cannot be read: ${e.message}`);
        throw e;
    }
    const expected = artifactSubjectFor(current, lens, manifest.digest);
    if (!expected)
        return refusal("invalid_input", `lens ${lens} is not selected for this review`);
    if (input.subject.subject_hash !== expected.subject_hash || result.subject_hash !== expected.subject_hash) {
        return refusal("binding_drift", "the result does not echo this lineage's artifact subject for the lens");
    }
    if (result.inspection.status === "unavailable")
        return refusal("inspection_unavailable", result.inspection.reason ?? "the candidate could not be inspected");
    const inspected = new Set(result.inspection.paths);
    if (inspected.size !== manifest.paths.length || manifest.paths.some((p) => !inspected.has(p))) {
        return refusal("inspection_incomplete", "inspection.paths must be exactly the changed-path manifest");
    }
    const findings = mapFindings(lens, result);
    if (!Array.isArray(findings))
        return findings;
    const resultHash = domainHash("lens-result", 1, { lineage_id: lineage, lens, result: input.result });
    const now = clock(opts);
    const done = await commit(() => updateState(commonDir, lineage, expectedRevision, (record) => {
        const admitted = admitLensResult(record, { lens, findings, resultHash, artifactDigest: expected.subject_hash, now });
        if (!admitted.ok)
            return admitted;
        if (lensesPending(admitted.record).length > 0)
            return admitted;
        return settleReview(admitted.record, { now, awaitRefuter: opts.awaitRefuter === true, randomToken: opts.randomToken });
    }));
    if (!("record" in done))
        return done;
    return statusOf(done.record, { ackToken: done.ackToken });
}
/** Settles a fully reviewed lineage that was held for a refuter (skip the refuter: correction, approval or escalation). */
export async function completeReview(commonDir, lineage, expectedRevision, opts = {}) {
    const now = clock(opts);
    const done = await commit(() => updateState(commonDir, lineage, expectedRevision, (record) => {
        if (record.state !== "reviewing")
            return { ok: false, refusal: { code: "illegal_state", message: `cannot complete a review from ${record.state}` } };
        if (lensesPending(record).length > 0)
            return { ok: false, refusal: { code: "lenses_incomplete", message: "every selected lens result must be admitted first" } };
        return settleReview(record, { now, awaitRefuter: false, randomToken: opts.randomToken });
    }));
    if (!("record" in done))
        return done;
    return statusOf(done.record, { ackToken: done.ackToken });
}
/**
 * Admits the optional refuter batch. Refuted findings drop out of the blocking set; corroborated, inconclusive and
 * unanswered ones stay blocking. Then the review settles (approval when nothing blocks, else the correction).
 */
export async function captureRefuterResult(commonDir, lineage, expectedRevision, input, opts = {}) {
    const current = readState(commonDir, lineage);
    if (current.revision !== expectedRevision) {
        return refusal("concurrent_update", "the review changed since the expected revision", { currentRevision: current.revision });
    }
    if (current.state !== "reviewing")
        return refusal("illegal_state", `cannot capture a refuter result from ${current.state}`);
    if (lensesPending(current).length > 0)
        return refusal("lenses_incomplete", "every selected lens result must be admitted before a refuter result");
    if (hasRole(current, "refuter"))
        return refusal("refuter_already_admitted", "a refuter result is already admitted");
    if (current.admitted_role_results.length >= MAX_ADMITTED_ROLE_RESULTS)
        return refusal("capacity_exceeded", "admitted role results are full");
    const errors = resultSchemaErrors.refuter(input?.result);
    if (errors.length > 0)
        return refusal("schema_invalid", "the refuter result does not match the refuter schema", { errors });
    const result = input.result;
    const requestHash = refuterRequestHash(current);
    if (result.refuter_request_hash !== requestHash)
        return refusal("binding_drift", "the result does not echo this review's refuter request");
    const blocking = new Set(blockingFindingIds(current));
    const seen = new Set();
    for (const r of result.results) {
        if (seen.has(r.finding_id))
            return refusal("invalid_input", `the refuter answered ${r.finding_id} twice`);
        seen.add(r.finding_id);
        if (!blocking.has(r.finding_id))
            return refusal("unknown_finding", `${r.finding_id} is not a blocking severe finding of this review`);
    }
    const refuted = result.results.filter((r) => r.outcome === "refuted").map((r) => r.finding_id).sort();
    const resultHash = domainHash("refuter-result", 1, { lineage_id: lineage, result: input.result });
    const now = clock(opts);
    const done = await commit(() => updateState(commonDir, lineage, expectedRevision, (record) => {
        const admitted = admitRefuterResult(record, { resultHash, artifactDigest: requestHash, refutedFindingIds: refuted, now });
        if (!admitted.ok)
            return admitted;
        return settleReview(admitted.record, { now, awaitRefuter: false, randomToken: opts.randomToken });
    }));
    if (!("record" in done))
        return done;
    return statusOf(done.record, { ackToken: done.ackToken });
}
export function planCorrection(commonDir, lineage) {
    const record = readState(commonDir, lineage);
    if (record.state !== "correction_required")
        return refusal("illegal_state", `no correction is pending in state ${record.state}`);
    const ids = new Set(record.fix_finding_ids);
    const findings = record.findings.filter((f) => ids.has(f.id)).map((f) => ({ ...f }));
    const paths = new Set();
    for (const f of findings) {
        const p = findingPath(f.location);
        if (p !== null)
            paths.add(p);
    }
    return {
        ok: true,
        lineage_id: record.lineage_id,
        revision: record.revision,
        findings,
        ledger_hash: record.ledger_hash ?? "",
        budget: record.correction_budget,
        attempts_remaining: Math.max(0, 1 - record.correction_attempts),
        allowed_paths: [...paths].sort(),
    };
}
/** The budget and scope checks of a correction against the frozen findings (no write). */
function checkCorrection(repo, current, corrected) {
    const commonDir = repo.commonDir;
    if (current.state !== "correction_required")
        return refusal("illegal_state", `cannot begin validation from ${current.state}`);
    if (typeof corrected?.candidateTree !== "string" || typeof corrected?.identity !== "string")
        return refusal("invalid_input", "the corrected candidate needs a tree and an identity");
    // Reference engine (compact.go: "compact correction has an unchanged candidate tree"): an unchanged candidate is not a
    // correction, and approving it would consume the defective original.
    if (corrected.candidateTree === current.candidate_tree || corrected.identity === current.target_identity) {
        return refusal("correction_unavailable", "the corrected candidate is unchanged: make a correction before validating");
    }
    let touched;
    let lines;
    try {
        touched = treeDiffPaths(commonDir, current.candidate_tree, corrected.candidateTree);
        lines = countChangedLines(repo, current.candidate_tree, corrected.candidateTree);
    }
    catch (e) {
        if (e instanceof SnapshotError || e instanceof RangeError)
            return refusal("snapshot_unavailable", `the corrected candidate cannot be compared: ${e.message}`);
        throw e;
    }
    const allowed = new Set();
    const ids = new Set(current.fix_finding_ids);
    for (const f of current.findings) {
        if (!ids.has(f.id))
            continue;
        const p = findingPath(f.location);
        if (p !== null)
            allowed.add(p);
    }
    const outside = touched.filter((p) => !allowed.has(p));
    if (outside.length > 0) {
        return refusal("correction_out_of_scope", `the correction touches paths outside the frozen findings: ${outside.join(", ")}`, { errors: outside });
    }
    return { ok: true, lines };
}
const beginInput = (corrected, lines, now) => ({
    now,
    actualCorrectionLines: lines,
    correctionTargetIdentity: corrected.identity,
    correctionCandidateTree: corrected.candidateTree,
});
/**
 * Checks the corrected candidate against the frozen correction (budget in changed lines against the ORIGINAL candidate;
 * only paths of the frozen findings) and opens validation. The single correction attempt is consumed here.
 */
export async function beginCorrectionValidation(repo, lineage, expectedRevision, corrected, opts = {}) {
    const commonDir = repo.commonDir;
    const current = readState(commonDir, lineage);
    if (current.revision !== expectedRevision) {
        return refusal("concurrent_update", "the review changed since the expected revision", { currentRevision: current.revision });
    }
    const checked = checkCorrection(repo, current, corrected);
    if (!checked.ok)
        return checked;
    const now = clock(opts);
    const done = await commit(() => updateState(commonDir, lineage, expectedRevision, (record) => beginValidation(record, beginInput(corrected, checked.lines, now))));
    if (!("record" in done))
        return done;
    return statusOf(done.record);
}
/**
 * What `captureCorrectionResult` would validate, with NO write: the budget and scope checks and the in-memory validating
 * record (its targeted-validation request hash is what the validator echoes). A forecast uses this, so it never spends
 * the single correction attempt.
 */
export function previewCorrectionValidation(repo, lineage, expectedRevision, corrected, opts = {}) {
    const current = readState(repo.commonDir, lineage);
    if (current.revision !== expectedRevision) {
        return refusal("concurrent_update", "the review changed since the expected revision", { currentRevision: current.revision });
    }
    const checked = checkCorrection(repo, current, corrected);
    if (!checked.ok)
        return checked;
    const began = beginValidation(current, beginInput(corrected, checked.lines, clock(opts)));
    if (!began.ok)
        return refusal(began.refusal.code, began.refusal.message);
    return { ok: true, record: began.record };
}
/** Checks a validator result against a validating record (schema, echoed request and target, inspection). No write. */
function judgeValidatorResult(current, lineage, input) {
    const errors = resultSchemaErrors.validator(input?.result);
    if (errors.length > 0)
        return refusal("schema_invalid", "the validator result does not match the targeted-validator schema", { errors });
    const result = input.result;
    const requestHash = targetedValidationRequestHash(current);
    if (requestHash === null)
        return refusal("binding_drift", "this review has no correction target to validate");
    if (result.targeted_validation_request_hash !== requestHash || result.correction_target_identity !== current.correction_target_identity) {
        return refusal("binding_drift", "the result does not echo this correction's validation request and target");
    }
    for (const [name, check] of [["original_criteria", result.original_criteria], ["correction_regression", result.correction_regression]]) {
        if (check.inspection?.status === "unavailable")
            return refusal("inspection_unavailable", `${name}: ${check.inspection.reason ?? "the corrected candidate could not be inspected"}`);
    }
    return {
        ok: true,
        requestHash,
        resultHash: domainHash("validator-result", 1, { lineage_id: lineage, result: input.result }),
        passed: result.original_criteria.passed && result.correction_regression.passed,
        failure: !result.original_criteria.passed
            ? "the targeted validator found the blocking findings unresolved"
            : "the targeted validator found regressions introduced by the correction",
    };
}
/** Admits the targeted validator result: approved when every blocking finding is resolved without regression, else escalated. */
export async function captureValidatorResult(commonDir, lineage, expectedRevision, 
/** `correctionCandidateTree`: frozen tree of the candidate that was judged; completes a validating record that lacks it. */
input, opts = {}) {
    const current = readState(commonDir, lineage);
    if (current.revision !== expectedRevision) {
        return refusal("concurrent_update", "the review changed since the expected revision", { currentRevision: current.revision });
    }
    if (current.state !== "validating")
        return refusal("illegal_state", `cannot capture a validator result from ${current.state}`);
    if (hasRole(current, "validator"))
        return refusal("validator_already_admitted", "a validator result is already admitted");
    if (current.admitted_role_results.length >= MAX_ADMITTED_ROLE_RESULTS)
        return refusal("capacity_exceeded", "admitted role results are full");
    const judged = judgeValidatorResult(current, lineage, input);
    if (!judged.ok)
        return judged;
    const now = clock(opts);
    const { requestHash, resultHash, passed, failure } = judged;
    const done = await commit(() => updateState(commonDir, lineage, expectedRevision, (record) => {
        const admitted = admitValidatorResult(record, { resultHash, artifactDigest: requestHash, now });
        if (!admitted.ok)
            return admitted;
        const tree = input.correctionCandidateTree;
        return passed
            ? approve(admitted.record, { now, randomToken: opts.randomToken, ...(tree !== undefined ? { correctionCandidateTree: tree } : {}) })
            : escalate(admitted.record, { now, reason: failure, ...(tree !== undefined ? { correctionCandidateTree: tree } : {}) });
    }));
    if (!("record" in done))
        return done;
    return statusOf(done.record, { ackToken: done.ackToken });
}
/**
 * Opens validation AND admits the validator result in ONE transition from `correction_required` (reference engine: the
 * attempt is recorded together with the validator's outcome). Nothing is written when the correction is refused or the
 * result does not match; a runner that never answered never spends the single correction attempt. The validator must
 * echo the request hash of `previewCorrectionValidation` for the same corrected candidate.
 */
export async function captureCorrectionResult(repo, lineage, expectedRevision, corrected, input, opts = {}) {
    const commonDir = repo.commonDir;
    const preview = previewCorrectionValidation(repo, lineage, expectedRevision, corrected, opts);
    if (!preview.ok)
        return preview;
    const judged = judgeValidatorResult(preview.record, lineage, input);
    if (!judged.ok)
        return judged;
    const now = clock(opts);
    const { requestHash, resultHash, passed, failure } = judged;
    const lines = preview.record.actual_correction_lines ?? 0;
    const done = await commit(() => updateState(commonDir, lineage, expectedRevision, (record) => {
        const began = beginValidation(record, beginInput(corrected, lines, now));
        if (!began.ok)
            return began;
        const admitted = admitValidatorResult(began.record, { resultHash, artifactDigest: requestHash, now });
        if (!admitted.ok)
            return admitted;
        return passed ? approve(admitted.record, { now, randomToken: opts.randomToken }) : escalate(admitted.record, { now, reason: failure });
    }));
    if (!("record" in done))
        return done;
    return statusOf(done.record, { ackToken: done.ackToken });
}
