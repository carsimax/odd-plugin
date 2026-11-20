export const SUPPORTED_KEYWORDS = [
    "type", "description", "enum", "const", "required", "properties", "additionalProperties", "minLength", "maxLength", "pattern",
    "minimum", "maximum", "items", "minItems", "maxItems", "uniqueItems", "default",
];
const MAX_ERRORS = 10;
const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** Validation errors as `path: message` lines (at most 10); empty when the value is valid. */
export function validateSchema(schema, value, path = "$") {
    const errors = [];
    const add = (message) => {
        if (errors.length < MAX_ERRORS)
            errors.push(`${path}: ${message}`);
    };
    const kind = kindOf(value);
    if (schema.type !== undefined) {
        const okType = schema.type === "integer" ? Number.isInteger(value)
            : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
                : kind === schema.type;
        if (!okType) {
            add(`expected ${schema.type}, got ${kind}`);
            return errors;
        }
    }
    if (schema.enum !== undefined && !schema.enum.includes(value))
        add(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    if (schema.const !== undefined && value !== schema.const)
        add(`must be ${JSON.stringify(schema.const)}`);
    if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < schema.minLength)
            add(`must have at least ${schema.minLength} characters`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength)
            add(`must have at most ${schema.maxLength} characters`);
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
            add(`must match ${schema.pattern}`);
    }
    if (typeof value === "number") {
        if (schema.minimum !== undefined && value < schema.minimum)
            add(`must be at least ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum)
            add(`must be at most ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems)
            add(`must have at least ${schema.minItems} items`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems)
            add(`must have at most ${schema.maxItems} items`);
        if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length)
            add("items must be unique");
        if (schema.items !== undefined) {
            for (let i = 0; i < value.length && errors.length < MAX_ERRORS; i++)
                errors.push(...validateSchema(schema.items, value[i], `${path}[${i}]`));
        }
    }
    if (kind === "object") {
        const obj = value;
        for (const key of schema.required ?? [])
            if (!Object.prototype.hasOwnProperty.call(obj, key))
                add(`missing required property ${key}`);
        const props = schema.properties ?? {};
        for (const key of Object.keys(obj)) {
            if (errors.length >= MAX_ERRORS)
                break;
            const sub = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
            if (sub === undefined) {
                if (schema.additionalProperties === false)
                    add(`unknown property ${key}`);
            }
            else
                errors.push(...validateSchema(sub, obj[key], `${path}.${key}`));
        }
    }
    return errors.slice(0, MAX_ERRORS);
}
