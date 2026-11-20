// Tiny dependency-free JSON Schema (draft 2020-12 subset) validator (U0).
// Supports only the keywords the vendored review contract schemas use. A schema that uses any other
// validation keyword throws SchemaError instead of silently passing.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "./canonical.js";
export class SchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = "SchemaError";
    }
}
const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "$defs", "title", "description", "examples", "default", "maxContains", "minContains"]);
const KEYWORDS = new Set([
    ...ANNOTATIONS, "$ref", "type", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum",
    "required", "properties", "additionalProperties", "dependentRequired", "items", "prefixItems", "minItems",
    "maxItems", "uniqueItems", "contains", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
]);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function typeOf(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    if (typeof value === "number")
        return Number.isInteger(value) ? "integer" : "number";
    return typeof value;
}
function matchesType(value, type) {
    const t = typeOf(value);
    return t === type || (type === "number" && t === "integer");
}
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
function pointer(doc, ptr) {
    if (ptr === "")
        return doc;
    if (!ptr.startsWith("/"))
        throw new SchemaError(`Unsupported $ref fragment "#${ptr}"`);
    let cur = doc;
    for (const raw of ptr.slice(1).split("/")) {
        const seg = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
        if (Array.isArray(cur))
            cur = cur[Number(seg)];
        else if (isObj(cur))
            cur = cur[seg];
        else
            cur = undefined;
        if (cur === undefined)
            throw new SchemaError(`Unresolvable $ref pointer "#${ptr}"`);
    }
    return cur;
}
function resolveRef(ref, ctx) {
    const hash = ref.indexOf("#");
    const file = hash === -1 ? ref : ref.slice(0, hash);
    const frag = hash === -1 ? "" : ref.slice(hash + 1);
    let next = ctx;
    if (file !== "") {
        const id = resolve(dirname(ctx.base), file);
        if (!ctx.docs.has(id))
            ctx.docs.set(id, ctx.opts.load(id));
        next = { ...ctx, doc: ctx.docs.get(id), base: id };
    }
    return { schema: pointer(next.doc, frag), ctx: next };
}
function compile(pattern, ctx) {
    let re = ctx.regex.get(pattern);
    if (!re) {
        try {
            re = new RegExp(pattern, "u");
        }
        catch {
            re = new RegExp(pattern);
        }
        ctx.regex.set(pattern, re);
    }
    return re;
}
function check(schema, value, path, ctx, errs) {
    if (schema === true)
        return;
    if (schema === false) {
        errs.push(`${path}: schema is false`);
        return;
    }
    if (!isObj(schema))
        throw new SchemaError(`Invalid schema at ${path || "/"}`);
    for (const k of Object.keys(schema))
        if (!KEYWORDS.has(k))
            throw new SchemaError(`Unsupported schema keyword "${k}"`);
    const fail = (msg) => errs.push(`${path}: ${msg}`);
    const valid = (s, v = value) => {
        const sub = [];
        check(s, v, path, ctx, sub);
        return sub.length === 0;
    };
    if (typeof schema.$ref === "string") {
        const r = resolveRef(schema.$ref, ctx);
        check(r.schema, value, path, r.ctx, errs);
    }
    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some((t) => matchesType(value, t)))
            fail(`expected type ${types.join("|")}, got ${typeOf(value)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value)))
        fail(`not one of the allowed values`);
    if ("const" in schema && !same(schema.const, value))
        fail(`does not equal the required constant`);
    if (typeof value === "string") {
        const len = [...value].length;
        if (typeof schema.minLength === "number" && len < schema.minLength)
            fail(`shorter than ${schema.minLength}`);
        if (typeof schema.maxLength === "number" && len > schema.maxLength)
            fail(`longer than ${schema.maxLength}`);
        if (typeof schema.pattern === "string" && !compile(schema.pattern, ctx).test(value))
            fail(`does not match pattern ${schema.pattern}`);
    }
    if (typeof value === "number") {
        if (typeof schema.minimum === "number" && value < schema.minimum)
            fail(`below minimum ${schema.minimum}`);
        if (typeof schema.maximum === "number" && value > schema.maximum)
            fail(`above maximum ${schema.maximum}`);
    }
    if (isObj(value)) {
        for (const key of schema.required ?? []) {
            if (!(key in value))
                fail(`missing required property "${key}"`);
        }
        const props = isObj(schema.properties) ? schema.properties : {};
        for (const [key, sub] of Object.entries(props)) {
            if (key in value)
                check(sub, value[key], `${path}/${key}`, ctx, errs);
        }
        if (schema.additionalProperties !== undefined) {
            for (const key of Object.keys(value)) {
                if (key in props)
                    continue;
                if (schema.additionalProperties === false)
                    errs.push(`${path}/${key}: additional property not allowed`);
                else
                    check(schema.additionalProperties, value[key], `${path}/${key}`, ctx, errs);
            }
        }
        if (isObj(schema.dependentRequired)) {
            for (const [key, needed] of Object.entries(schema.dependentRequired)) {
                if (!(key in value))
                    continue;
                for (const n of needed)
                    if (!(n in value))
                        fail(`"${key}" requires "${n}"`);
            }
        }
    }
    if (Array.isArray(value)) {
        if (typeof schema.minItems === "number" && value.length < schema.minItems)
            fail(`fewer than ${schema.minItems} items`);
        if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
            fail(`more than ${schema.maxItems} items`);
        if (schema.uniqueItems === true) {
            const seen = new Set();
            for (const item of value) {
                const key = canonicalJson(item);
                if (seen.has(key)) {
                    fail(`items are not unique`);
                    break;
                }
                seen.add(key);
            }
        }
        const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
        prefix.forEach((sub, i) => {
            if (i < value.length)
                check(sub, value[i], `${path}/${i}`, ctx, errs);
        });
        if (schema.items !== undefined) {
            for (let i = prefix.length; i < value.length; i++)
                check(schema.items, value[i], `${path}/${i}`, ctx, errs);
        }
        if (schema.contains !== undefined) {
            const min = typeof schema.minContains === "number" ? schema.minContains : 1;
            const max = typeof schema.maxContains === "number" ? schema.maxContains : Infinity;
            const n = value.filter((item) => valid(schema.contains, item)).length;
            if (n < min)
                fail(`fewer than ${min} items match "contains"`);
            if (n > max)
                fail(`more than ${max} items match "contains"`);
        }
    }
    if (Array.isArray(schema.allOf))
        for (const s of schema.allOf)
            check(s, value, path, ctx, errs);
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => valid(s)))
        fail(`matches none of anyOf`);
    if (Array.isArray(schema.oneOf)) {
        const n = schema.oneOf.filter((s) => valid(s)).length;
        if (n !== 1)
            fail(`matches ${n} of oneOf, expected exactly 1`);
    }
    if (schema.not !== undefined && valid(schema.not))
        fail(`matches a "not" schema`);
    if (schema.if !== undefined) {
        if (valid(schema.if)) {
            if (schema.then !== undefined)
                check(schema.then, value, path, ctx, errs);
        }
        else if (schema.else !== undefined)
            check(schema.else, value, path, ctx, errs);
    }
}
/** Returns the list of violations ("<instance path>: <message>"); empty means valid. */
export function validate(schema, value, opts) {
    const errs = [];
    const ctx = { doc: schema, base: opts.base, opts, docs: new Map([[opts.base, schema]]), regex: new Map() };
    check(schema, value, "", ctx, errs);
    return errs;
}
/** Validates against a schema file; relative $ref files resolve next to it. */
export function validateFile(schemaFile, value) {
    const file = resolve(schemaFile);
    const load = (id) => JSON.parse(readFileSync(id, "utf8"));
    return validate(load(file), value, { base: file, load });
}
