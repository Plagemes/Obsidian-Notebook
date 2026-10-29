/**
 * Tolerant JSON reader for the repair of damaged notebooks (roadmap #140). Pure, no Obsidian imports.
 *
 * It reads standard JSON and, where the text is cut off or damaged, keeps everything that was read
 * completely up to that point: every open object and array is closed where the damage starts. A value
 * that was only partly read is dropped, never guessed: a cut number ("72.5" read as "72") or string
 * would silently change the data. Containers that were closed early are reported in `incomplete`, so
 * the caller can tell a cut-off stroke from a whole one.
 */

export interface LenientResult {
	/** What could be read; undefined when not even the first value could be read. */
	value: unknown;
	/** True when the whole text is valid JSON (then `value` equals JSON.parse(text)). */
	complete: boolean;
	/** Character offset where reading stopped because of damage or the end of the text, or null. */
	stoppedAt: number | null;
	/** Objects and arrays that were closed early because the text after them is missing or damaged. */
	incomplete: WeakSet<object>;
}

/** Nesting deeper than this is treated as damage (a notebook is at most 6 levels deep). */
const MAX_DEPTH = 64;
/** Marks a value that could not be read (distinct from every JSON value). */
const FAIL: unique symbol = Symbol("fail");
/** A JSON value, or FAIL. */
type Read = unknown;

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Reader {
	pos = 0;
	/** Set once damage is found: every open container closes and returns what it has. */
	stopped = false;
	stoppedAt: number | null = null;
	readonly incomplete = new WeakSet<object>();

	constructor(private readonly text: string) {}

	private stop(at = this.pos): void {
		if (!this.stopped) {
			this.stopped = true;
			this.stoppedAt = at;
		}
	}

	ws(): void {
		const s = this.text;
		while (this.pos < s.length) {
			const c = s.charCodeAt(this.pos);
			if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) this.pos++;
			else break;
		}
	}

	value(depth: number): Read {
		this.ws();
		if (this.pos >= this.text.length || depth > MAX_DEPTH) {
			this.stop();
			return FAIL;
		}
		const c = this.text[this.pos];
		if (c === "{") return this.object(depth);
		if (c === "[") return this.array(depth);
		if (c === "\"") return this.string();
		if (c === "t") return this.literal("true", true);
		if (c === "f") return this.literal("false", false);
		if (c === "n") return this.literal("null", null);
		return this.number();
	}

	private literal(word: string, v: unknown): Read {
		if (this.text.startsWith(word, this.pos)) {
			this.pos += word.length;
			return v;
		}
		this.stop();
		return FAIL;
	}

	private number(): Read {
		NUMBER_RE.lastIndex = this.pos;
		const m = NUMBER_RE.exec(this.text);
		if (!m) {
			this.stop();
			return FAIL;
		}
		const end = this.pos + m[0].length;
		// A number that touches the end of the text may have been cut: drop it.
		if (end >= this.text.length) {
			this.stop();
			return FAIL;
		}
		const next = this.text[end]!;
		if (!",]} \t\r\n".includes(next)) {
			this.stop();
			return FAIL;
		}
		this.pos = end;
		return Number(m[0]);
	}

	private string(): Read {
		const s = this.text;
		const start = this.pos;
		let i = start + 1;
		let out = "";
		let chunk = i;
		while (i < s.length) {
			const c = s.charCodeAt(i);
			if (c === 0x22) {
				out += s.slice(chunk, i);
				this.pos = i + 1;
				return out;
			}
			if (c < 0x20) break; // raw control character: not JSON, the text is damaged here
			if (c === 0x5c) {
				out += s.slice(chunk, i);
				const e = s[i + 1];
				const simple: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
				if (e !== undefined && simple[e] !== undefined) {
					out += simple[e];
					i += 2;
				} else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
					out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
					i += 6;
				} else {
					break;
				}
				chunk = i;
				continue;
			}
			i++;
		}
		this.stop(start);
		return FAIL;
	}

	private object(depth: number): Read {
		const obj: Record<string, unknown> = {};
		this.pos++; // {
		this.ws();
		if (this.text[this.pos] === "}") {
			this.pos++;
			return obj;
		}
		for (;;) {
			this.ws();
			if (this.text[this.pos] !== "\"") {
				this.stop();
				break;
			}
			const key = this.string();
			if (key === FAIL) break;
			this.ws();
			if (this.text[this.pos] !== ":") {
				this.stop();
				break;
			}
			this.pos++;
			const v = this.value(depth + 1);
			if (v === FAIL) break;
			// Never let a key reach the prototype.
			if (key !== "__proto__") obj[key as string] = v;
			if (this.stopped) break;
			this.ws();
			const c = this.text[this.pos];
			if (c === ",") {
				this.pos++;
				continue;
			}
			if (c === "}") {
				this.pos++;
				return obj;
			}
			this.stop();
			break;
		}
		this.incomplete.add(obj);
		return obj;
	}

	private array(depth: number): Read {
		const arr: unknown[] = [];
		this.pos++; // [
		this.ws();
		if (this.text[this.pos] === "]") {
			this.pos++;
			return arr;
		}
		for (;;) {
			const v = this.value(depth + 1);
			if (v === FAIL) break;
			arr.push(v);
			if (this.stopped) break;
			this.ws();
			const c = this.text[this.pos];
			if (c === ",") {
				this.pos++;
				continue;
			}
			if (c === "]") {
				this.pos++;
				return arr;
			}
			this.stop();
			break;
		}
		this.incomplete.add(arr);
		return arr;
	}
}

/** Reads as much of `text` as is intact. Never throws. */
export function parseLenient(text: string): LenientResult {
	try {
		const value: unknown = JSON.parse(text);
		return { value, complete: true, stoppedAt: null, incomplete: new WeakSet() };
	} catch {
		// fall through to the tolerant reader
	}
	// A byte-order mark is not JSON but is harmless.
	const r = new Reader(text.charCodeAt(0) === 0xfeff ? ` ${text.slice(1)}` : text);
	const v = r.value(0);
	if (!r.stopped) {
		r.ws();
		// Trailing garbage after a complete value.
		if (r.pos < text.length) r.stoppedAt = r.pos;
	}
	return { value: v === FAIL ? undefined : v, complete: false, stoppedAt: r.stoppedAt, incomplete: r.incomplete };
}
