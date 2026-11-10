/**
 * Saving the calculator's variables and functions (#182) as plain JSON and reading them back leniently: a bad entry is
 * dropped, never an error, and the number of entries and their sizes are bounded. The document format is not involved:
 * the store lives in the device's local storage (src/ui/calc-store.ts). Pure: no 'obsidian', no DOM.
 */
import { CalcSession, MAX_VARS, evaluate, isReserved, type Quantity, type Value } from "./calc";
import { cx, frac, isCx, isFrac, mat, type Entry } from "./calc-number";
import { parseStatement } from "./calc-parse";
import { lookupUnit } from "./calc-units";

/** One saved number: an exact rational ("n/d" as decimal strings), a double, or a complex pair. */
export type SavedEntry = { n: string; d: string } | { x: number } | { re: number; im: number };

export type SavedValue =
	| { t: "q"; v: SavedEntry; dim: number[]; unit: Array<[string, number]> | null; dec: boolean }
	| { t: "m"; rows: number; cols: number; a: SavedEntry[]; dec: boolean };

export type SavedName = { kind: "val"; value: SavedValue } | { kind: "fn"; params: string[]; body: string };

const NAME = /^[\p{L}_][\p{L}\p{N}_]{0,31}$/u;

function saveEntry(e: Entry): SavedEntry {
	if (isCx(e)) return { re: e.re, im: e.im };
	if (isFrac(e)) return { n: e.n.toString(), d: e.d.toString() };
	return { x: e };
}

function loadEntry(s: unknown): Entry | null {
	if (typeof s !== "object" || s === null) return null;
	const o = s as Record<string, unknown>;
	if (typeof o.n === "string" && typeof o.d === "string" && /^-?\d{1,400}$/.test(o.n) && /^\d{1,400}$/.test(o.d) && o.d !== "0") {
		try {
			return frac(BigInt(o.n), BigInt(o.d));
		} catch {
			return null;
		}
	}
	if (typeof o.x === "number" && Number.isFinite(o.x)) return o.x;
	if (typeof o.re === "number" && typeof o.im === "number" && Number.isFinite(o.re) && Number.isFinite(o.im)) return cx(o.re, o.im);
	return null;
}

export function saveValue(v: Value): SavedValue {
	if (v.t === "m") return { t: "m", rows: v.m.rows, cols: v.m.cols, a: v.m.a.map(saveEntry), dec: v.dec };
	return { t: "q", v: saveEntry(v.v), dim: [...v.dim], unit: v.unit ? [...v.unit] : null, dec: v.dec };
}

export function loadValue(s: unknown): Value | null {
	if (typeof s !== "object" || s === null) return null;
	const o = s as Record<string, unknown>;
	if (o.t === "m") {
		if (typeof o.rows !== "number" || typeof o.cols !== "number" || !Array.isArray(o.a)) return null;
		if (!Number.isInteger(o.rows) || !Number.isInteger(o.cols) || o.rows < 1 || o.cols < 1 || o.a.length !== o.rows * o.cols || o.a.length > 1000) return null;
		const a: Entry[] = [];
		for (const e of o.a as unknown[]) {
			const x = loadEntry(e);
			if (x === null) return null;
			a.push(x);
		}
		try {
			return { t: "m", m: mat(o.rows, o.cols, a), dec: o.dec === true };
		} catch {
			return null;
		}
	}
	if (o.t !== "q") return null;
	const v = loadEntry(o.v);
	if (v === null || !Array.isArray(o.dim) || o.dim.length !== 7 || !o.dim.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
	let unit: Map<string, number> | null = null;
	if (Array.isArray(o.unit)) {
		unit = new Map();
		for (const p of o.unit as unknown[]) {
			if (!Array.isArray(p) || typeof p[0] !== "string" || typeof p[1] !== "number" || !Number.isFinite(p[1]) || !lookupUnit(p[0])) return null;
			unit.set(p[0], p[1]);
		}
	}
	const q: Quantity = { t: "q", v, dim: o.dim as number[], unit, dec: o.dec === true };
	return q;
}

/** What to keep of a session: its variables and functions. */
export function saveSession(session: CalcSession): Record<string, SavedName> {
	const out: Record<string, SavedName> = {};
	for (const [name, value] of session.vars) out[name] = { kind: "val", value: saveValue(value) };
	for (const [name, f] of session.fns) out[name] = { kind: "fn", params: f.params, body: f.body };
	return out;
}

/**
 * Restores saved names into `session`. Functions are re-read from their text (and dropped when they no longer parse
 * or use a name that is gone); a bad entry is skipped.
 */
export function restoreSession(session: CalcSession, saved: unknown): void {
	if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return;
	const entries = Object.entries(saved as Record<string, unknown>).slice(0, MAX_VARS * 2);
	const fns: Array<[string, string[], string]> = [];
	for (const [name, raw] of entries) {
		if (!NAME.test(name) || isReserved(name) || typeof raw !== "object" || raw === null) continue;
		const r = raw as Record<string, unknown>;
		if (r.kind === "val") {
			if (session.vars.size >= MAX_VARS) continue;
			const v = loadValue(r.value);
			if (v) session.vars.set(name, v);
		} else if (r.kind === "fn" && Array.isArray(r.params) && typeof r.body === "string" && r.params.every((p) => typeof p === "string" && NAME.test(p)) && r.params.length <= 6 && r.body.length <= 1000) {
			fns.push([name, r.params as string[], r.body]);
		}
	}
	// Functions last, in the order saved: a function may use an earlier one.
	for (const [name, params, body] of fns) {
		if (session.fns.size + session.vars.size >= MAX_VARS) break;
		const probe = `${name}(${params.join(", ")}) = ${body}`;
		try {
			parseStatement(probe, { isVar: (n) => session.vars.has(n), isFn: () => true });
		} catch {
			continue;
		}
		evaluate(probe, session);
	}
}

