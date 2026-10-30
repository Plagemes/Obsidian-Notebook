/**
 * This device's record for the library check (roadmap 27): when it first saw each asset file unused
 * (`<notebooks folder>/_meta/library-check-<device>.json`). Pure: no 'obsidian', the vault is reached through an adapter.
 *
 * Why it exists: the modification time of a file is the one of the device it came from (Google Drive and OneDrive keep it), so
 * it cannot say how long *this* device has known the file. A picture can arrive before the notebook that uses it. The check
 * offers an asset only if an earlier check on this device saw it unused at least a day before and it is still unused.
 *
 * - One file per device, like the library state: a device only ever writes its own, so two synced devices never write the
 *   same file and the sync service has nothing to conflict on. Other devices' files are never read: what another device saw
 *   says nothing about what this one has been shown.
 * - Written only by a complete check (see `runLibraryCheck`) and only when the content changes.
 * - A file that is missing is an empty record. A file that is empty (it may not have finished syncing), cannot be read, is
 *   not ours or is from a newer version is never overwritten: a copy is kept, `load` gives null and nothing is offered.
 * - The file names assets, but it is not a reference to them: the check skips it when it reads `_meta`.
 */
import { deviceFileName, EMPTY_FILE_MESSAGE, ensureFolderPath, keepUnreadableCopy } from "../storage/device-files";
import { linksFolder, type LinkFileAdapter } from "../storage/pdf-links-store";
import type { SeenStore } from "./library-check";

export const SEEN_FORMAT = "obsidian-notebook-library-check";
export const SEEN_VERSION = 1;
/** `_meta/library-check-<device>.json` */
export const SEEN_PREFIX = "library-check";

export type SeenParse = { ok: true; seen: Map<string, number> } | { ok: false; message: string };

const ASSET_ID = /^[0-9a-f]{24}$/;

export function parseSeen(text: string): SeenParse {
	if (text.trim() === "") return { ok: false, message: EMPTY_FILE_MESSAGE };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, message: `invalid JSON: ${(e as Error).message}` };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, message: "not a library check record" };
	const o = raw as Record<string, unknown>;
	if (o.format !== SEEN_FORMAT) return { ok: false, message: "not a library check record" };
	if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1) return { ok: false, message: "bad version" };
	if (o.version > SEEN_VERSION) return { ok: false, message: `version ${o.version} is newer than this plugin understands` };
	if (typeof o.seen !== "object" || o.seen === null || Array.isArray(o.seen)) return { ok: false, message: "seen is not a map" };
	const seen = new Map<string, number>();
	for (const [id, at] of Object.entries(o.seen as Record<string, unknown>)) {
		if (!ASSET_ID.test(id) || typeof at !== "number" || !Number.isFinite(at)) return { ok: false, message: "bad entry" };
		seen.set(id, at);
	}
	return { ok: true, seen };
}

/** Deterministic text: sorted by id. */
export function serializeSeen(seen: ReadonlyMap<string, number>, device: string): string {
	const ids = [...seen.keys()].sort();
	const head = `{"format":${JSON.stringify(SEEN_FORMAT)},"version":${SEEN_VERSION},"device":${JSON.stringify(device)},"seen":{`;
	return `${head}${ids.length ? `\n${ids.map((id) => `${JSON.stringify(id)}:${seen.get(id)}`).join(",\n")}\n` : ""}}}\n`;
}

export class LibraryCheckSeenStore implements SeenStore {
	constructor(
		private readonly adapter: LinkFileAdapter,
		private readonly notebooksFolder: () => string,
		readonly device: string,
	) {}

	get folder(): string {
		return linksFolder(this.notebooksFolder());
	}

	/** This device's file. */
	get path(): string {
		return `${this.folder}/${deviceFileName(SEEN_PREFIX, this.device)}`;
	}

	async load(): Promise<Map<string, number> | null> {
		if (!(await this.adapter.exists(this.path))) return new Map();
		const text = await this.adapter.read(this.path);
		const parsed = parseSeen(text);
		if (!parsed.ok) {
			if (text.trim() !== "") await keepUnreadableCopy(this.adapter, this.folder, SEEN_PREFIX, text);
			return null;
		}
		return parsed.seen;
	}

	async save(seen: ReadonlyMap<string, number>): Promise<void> {
		// The file as it is now: never write over one that cannot be read (it may be a record still arriving).
		if (await this.adapter.exists(this.path)) {
			const now = parseSeen(await this.adapter.read(this.path));
			if (!now.ok) throw new Error(`${this.path}: ${now.message}`);
		}
		const text = serializeSeen(seen, this.device);
		if (!parseSeen(text).ok) throw new Error("library check record did not validate");
		await ensureFolderPath(this.adapter, this.folder);
		await this.adapter.write(this.path, text);
	}
}
