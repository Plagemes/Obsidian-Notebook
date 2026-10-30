// Typed helpers for tests that build and corrupt raw JSON of old or invalid document formats.
// Raw JSON is `unknown` until a test narrows it; these helpers read and write nested values by path
// (an array of keys and indexes) without `any`.

/** A JSON object as parsed from a file, before any validation. */
export type Raw = Record<string, unknown>;

/** A key (object property) or an index (array element). */
export type RawPath = ReadonlyArray<string | number>;

function container(root: unknown, path: RawPath): Record<string, unknown> {
	let cur: unknown = root;
	for (const key of path) {
		if (typeof cur !== "object" || cur === null) throw new Error(`raw-json: no container at ${String(key)}`);
		cur = (cur as Record<string, unknown>)[key];
	}
	if (typeof cur !== "object" || cur === null) throw new Error("raw-json: the path does not lead to an object or array");
	return cur as Record<string, unknown>;
}

/** Parse JSON text into a loosely typed object. */
export function parseRaw(text: string): Raw {
	return JSON.parse(text) as Raw;
}

/** Read the value at `path`; `undefined` when any step is missing. */
export function getAt<T = unknown>(root: unknown, path: RawPath): T {
	let cur: unknown = root;
	for (const key of path) {
		if (typeof cur !== "object" || cur === null) return undefined as T;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur as T;
}

/** Set the value at `path` (the parent must exist). */
export function setAt(root: unknown, path: RawPath, value: unknown): void {
	const last = path[path.length - 1];
	if (last === undefined) throw new Error("raw-json: empty path");
	container(root, path.slice(0, -1))[last] = value;
}

/** Delete the key (or array slot) at `path`. */
export function delAt(root: unknown, path: RawPath): void {
	const last = path[path.length - 1];
	if (last === undefined) throw new Error("raw-json: empty path");
	delete container(root, path.slice(0, -1))[last];
}

/** Push onto the array at `path`. */
export function pushAt(root: unknown, path: RawPath, ...items: unknown[]): void {
	const arr = getAt<unknown>(root, path);
	if (!Array.isArray(arr)) throw new Error("raw-json: not an array");
	arr.push(...items);
}
