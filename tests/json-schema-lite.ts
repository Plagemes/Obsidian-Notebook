// A small, dependency-free JSON Schema (draft 2020-12) validator for the tests of docs/schema/notebook-v18.schema.json.
// It supports exactly the keywords that schema uses and THROWS on any other keyword, so a schema edit that adds an unsupported
// keyword fails loudly instead of being silently ignored. It is test tooling only: it is never bundled into the plugin.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = boolean | { [key: string]: Json };

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "$comment", "title", "description", "default", "examples"]);
const KNOWN = new Set([
	"$ref", "type", "const", "enum", "properties", "required", "additionalProperties", "propertyNames", "items", "prefixItems",
	"minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
	"allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentRequired",
]);

function isObject(v: unknown): v is { [key: string]: Json } {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
	return typeof v;
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Number of Unicode code points (what JSON Schema's minLength / maxLength count). */
function codePoints(s: string): number {
	let n = 0;
	for (const _ of s) { void _; n++; }
	return n;
}

export class SchemaValidator {
	private readonly regexes = new Map<string, RegExp>();

	constructor(private readonly root: { [key: string]: Json }) {}

	/** Errors of `value` against the root schema (empty = valid). Each error starts with the JSON path of the offending value. */
	validate(value: unknown): string[] {
		const errors: string[] = [];
		this.check(this.root, value, "$", errors);
		return errors;
	}

	private resolve(ref: string): Schema {
		if (ref === "#") return this.root;
		if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
		let cur: Json = this.root;
		for (const part of ref.slice(2).split("/")) {
			if (!isObject(cur) || !(part in cur)) throw new Error(`unresolved $ref ${ref}`);
			cur = cur[part] as Json;
		}
		if (typeof cur !== "boolean" && !isObject(cur)) throw new Error(`$ref ${ref} is not a schema`);
		return cur;
	}

	private regex(pattern: string): RegExp {
		let re = this.regexes.get(pattern);
		if (!re) {
			re = new RegExp(pattern, "u");
			this.regexes.set(pattern, re);
		}
		return re;
	}

	private ok(schema: Schema, value: unknown): boolean {
		const errs: string[] = [];
		this.check(schema, value, "$", errs);
		return errs.length === 0;
	}

	private check(schema: Schema, value: unknown, path: string, errors: string[]): void {
		if (typeof schema === "boolean") {
			if (!schema) errors.push(`${path}: not allowed`);
			return;
		}
		for (const key of Object.keys(schema)) {
			if (!KNOWN.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported schema keyword "${key}" at ${path}`);
		}
		const s = schema;
		if (typeof s.$ref === "string") this.check(this.resolve(s.$ref), value, path, errors);

		if (s.type !== undefined) {
			const wanted = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
			const actual = typeOf(value);
			if (!wanted.some((t) => t === actual || (t === "number" && actual === "integer"))) {
				errors.push(`${path}: expected ${wanted.join("|")}, found ${actual}`);
				return;
			}
		}
		if ("const" in s && !sameJson(s.const, value)) errors.push(`${path}: expected the constant ${JSON.stringify(s.const)}`);
		if (Array.isArray(s.enum) && !s.enum.some((e) => sameJson(e, value))) errors.push(`${path}: not one of ${JSON.stringify(s.enum)}`);

		if (typeof value === "number") {
			if (typeof s.minimum === "number" && value < s.minimum) errors.push(`${path}: below ${s.minimum}`);
			if (typeof s.maximum === "number" && value > s.maximum) errors.push(`${path}: above ${s.maximum}`);
			if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) errors.push(`${path}: not above ${s.exclusiveMinimum}`);
			if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) errors.push(`${path}: not below ${s.exclusiveMaximum}`);
		}
		if (typeof value === "string") {
			const n = codePoints(value);
			if (typeof s.minLength === "number" && n < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
			if (typeof s.maxLength === "number" && n > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
			if (typeof s.pattern === "string" && !this.regex(s.pattern).test(value)) errors.push(`${path}: does not match ${s.pattern}`);
		}
		if (Array.isArray(value)) this.checkArray(s, value, path, errors);
		if (isObject(value)) this.checkObject(s, value, path, errors);

		if (Array.isArray(s.allOf)) for (const sub of s.allOf) this.check(sub as Schema, value, path, errors);
		if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => this.ok(sub as Schema, value))) errors.push(`${path}: matches none of anyOf`);
		if (Array.isArray(s.oneOf)) {
			const matching = s.oneOf.filter((sub) => this.ok(sub as Schema, value)).length;
			if (matching !== 1) {
				// Say why when nothing matches: the errors of the branch the value looks most like (fewest errors).
				let detail = "";
				if (matching === 0) {
					let best: string[] | null = null;
					for (const sub of s.oneOf) {
						const errs: string[] = [];
						this.check(sub as Schema, value, path, errs);
						if (best === null || errs.length < best.length) best = errs;
					}
					detail = best ? ` (closest: ${best.slice(0, 3).join("; ")})` : "";
				}
				errors.push(`${path}: matches ${matching} of oneOf, expected 1${detail}`);
			}
		}
		if (s.not !== undefined && this.ok(s.not as Schema, value)) errors.push(`${path}: matches a forbidden schema`);
		if (s.if !== undefined) {
			if (this.ok(s.if as Schema, value)) {
				if (s.then !== undefined) this.check(s.then as Schema, value, path, errors);
			} else if (s.else !== undefined) this.check(s.else as Schema, value, path, errors);
		}
	}

	private checkArray(s: { [key: string]: Json }, value: unknown[], path: string, errors: string[]): void {
		if (typeof s.minItems === "number" && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
		if (typeof s.maxItems === "number" && value.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
		const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
		prefix.forEach((sub, i) => {
			if (i < value.length) this.check(sub, value[i], `${path}[${i}]`, errors);
		});
		if (s.items !== undefined) {
			for (let i = prefix.length; i < value.length; i++) this.check(s.items as Schema, value[i], `${path}[${i}]`, errors);
		}
	}

	private checkObject(s: { [key: string]: Json }, value: { [key: string]: unknown }, path: string, errors: string[]): void {
		const props = isObject(s.properties) ? s.properties : {};
		if (Array.isArray(s.required)) {
			for (const key of s.required) if (!((key as string) in value)) errors.push(`${path}: missing "${key as string}"`);
		}
		if (isObject(s.dependentRequired)) {
			for (const [key, needs] of Object.entries(s.dependentRequired)) {
				if (key in value) for (const need of needs as string[]) if (!(need in value)) errors.push(`${path}: "${key}" needs "${need}"`);
			}
		}
		for (const [key, v] of Object.entries(value)) {
			const at = `${path}.${key}`;
			if (s.propertyNames !== undefined) this.check(s.propertyNames as Schema, key, `${at}(name)`, errors);
			if (Object.prototype.hasOwnProperty.call(props, key)) this.check(props[key] as Schema, v, at, errors);
			else if (s.additionalProperties !== undefined) this.check(s.additionalProperties as Schema, v, at, errors);
		}
	}
}
