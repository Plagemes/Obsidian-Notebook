import { detectVersion, migrate, MigrationError, type RawObject } from "./migrations";
import {
	CURRENT_VERSION, FORMAT_ID,
	type Page, type Point, type NotebookDocument, type Stroke,
} from "./types";

export type ParseFailure =
	| "empty"
	| "json"
	| "not-notebook"
	| "future-version"
	| "invalid";

export type ParseResult =
	| { ok: true; doc: NotebookDocument; migratedFrom: number | null }
	| { ok: false; reason: ParseFailure; message: string; version?: number };

/**
 * Deterministic serialization: fixed key order, one stroke per line.
 * `serialize(parse(s).doc) === s` for every `s` produced by this function.
 */
export function serialize(doc: NotebookDocument): string {
	const j = JSON.stringify;
	const pages = doc.pages.map((page) => {
		const strokes = page.strokes.map((s) =>
			`\t\t\t\t{"id":${j(s.id)},"tool":${j(s.tool)},"color":${j(s.color)},"width":${j(s.width)},"points":${j(s.points)}}`,
		);
		return [
			"\t\t{",
			`\t\t\t"id": ${j(page.id)},`,
			`\t\t\t"width": ${j(page.width)},`,
			`\t\t\t"height": ${j(page.height)},`,
			`\t\t\t"paper": {"kind":${j(page.paper.kind)},"spacing":${j(page.paper.spacing)}},`,
			strokes.length ? `\t\t\t"strokes": [\n${strokes.join(",\n")}\n\t\t\t]` : `\t\t\t"strokes": []`,
			"\t\t}",
		].join("\n");
	});
	return [
		"{",
		`\t"format": ${j(doc.format)},`,
		`\t"version": ${j(doc.version)},`,
		`\t"id": ${j(doc.id)},`,
		`\t"createdAt": ${j(doc.createdAt)},`,
		`\t"modifiedAt": ${j(doc.modifiedAt)},`,
		`\t"pages": [\n${pages.join(",\n")}\n\t]`,
		"}",
		"",
	].join("\n");
}

class ValidationError extends Error {}

function fail(path: string, what: string): never {
	throw new ValidationError(`${path}: ${what}`);
}

function isObject(v: unknown): v is RawObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
	if (typeof v !== "string" || v.length === 0) fail(path, "expected a non-empty string");
	return v;
}

function positive(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(path, "expected a positive number");
	return v;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function readPoint(v: unknown, path: string): Point {
	if (!Array.isArray(v) || v.length !== 3) fail(path, "expected a [x, y, pressure] point");
	const [x, y, p] = v as unknown[];
	if (typeof x !== "number" || !Number.isFinite(x)) fail(path, "invalid x");
	if (typeof y !== "number" || !Number.isFinite(y)) fail(path, "invalid y");
	if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) fail(path, "pressure outside [0, 1]");
	return [x, y, p];
}

function readStroke(v: unknown, path: string, ids: Set<string>): Stroke {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	if (ids.has(id)) fail(`${path}.id`, "duplicate id");
	ids.add(id);
	if (v.tool !== "pen") fail(`${path}.tool`, "unknown tool");
	if (typeof v.color !== "string" || !COLOR_RE.test(v.color)) fail(`${path}.color`, "expected a #rrggbb colour");
	const width = positive(v.width, `${path}.width`);
	if (!Array.isArray(v.points) || v.points.length === 0) fail(`${path}.points`, "expected at least one point");
	const points = v.points.map((pt, i) => readPoint(pt, `${path}.points[${i}]`));
	return { id, tool: "pen", color: v.color, width, points };
}

function readPage(v: unknown, path: string, ids: Set<string>): Page {
	if (!isObject(v)) fail(path, "expected an object");
	const id = str(v.id, `${path}.id`);
	const width = positive(v.width, `${path}.width`);
	const height = positive(v.height, `${path}.height`);
	const paper = v.paper;
	if (!isObject(paper) || paper.kind !== "grid") fail(`${path}.paper`, "unknown paper");
	const spacing = positive(paper.spacing, `${path}.paper.spacing`);
	if (!Array.isArray(v.strokes)) fail(`${path}.strokes`, "expected an array");
	const strokes = v.strokes.map((s, i) => readStroke(s, `${path}.strokes[${i}]`, ids));
	return { id, width, height, paper: { kind: "grid", spacing }, strokes };
}

/** Validates an object already at the current version and returns a copy with known fields only. */
export function validate(raw: unknown): NotebookDocument {
	if (!isObject(raw)) fail("document", "expected an object");
	if (raw.format !== FORMAT_ID) fail("format", `expected "${FORMAT_ID}"`);
	if (raw.version !== CURRENT_VERSION) fail("version", `expected ${CURRENT_VERSION}`);
	const id = str(raw.id, "id");
	const createdAt = str(raw.createdAt, "createdAt");
	const modifiedAt = str(raw.modifiedAt, "modifiedAt");
	if (!Array.isArray(raw.pages) || raw.pages.length === 0) fail("pages", "expected at least one page");
	const ids = new Set<string>();
	const pages = raw.pages.map((p, i) => readPage(p, `pages[${i}]`, ids));
	return { format: FORMAT_ID, version: CURRENT_VERSION, id, createdAt, modifiedAt, pages };
}

export function parse(text: string): ParseResult {
	if (text.trim().length === 0) return { ok: false, reason: "empty", message: "the file is empty" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw)) return { ok: false, reason: "not-notebook", message: "not a Notebook document" };
	const version = detectVersion(raw);
	if (version === null || (version >= 1 && raw.format !== FORMAT_ID)) {
		return { ok: false, reason: "not-notebook", message: "not a Notebook document" };
	}
	if (version > CURRENT_VERSION) {
		return {
			ok: false, reason: "future-version", version,
			message: `created by a newer version of Notebook (format v${version}, this version reads up to v${CURRENT_VERSION})`,
		};
	}
	try {
		const migrated = version < CURRENT_VERSION ? migrate(raw, version, CURRENT_VERSION) : raw;
		return { ok: true, doc: validate(migrated), migratedFrom: version < CURRENT_VERSION ? version : null };
	} catch (e) {
		if (e instanceof ValidationError || e instanceof MigrationError) {
			return { ok: false, reason: "invalid", message: e.message, version };
		}
		throw e;
	}
}
