/**
 * Which notebook file a global bookmark opens (roadmap #265). Pure: no 'obsidian' (the vault is reached through `ResolveDeps`).
 *
 * The file at the bookmark's path is trusted only when it is still the notebook the bookmark was made in: when the bookmark has a notebook id and the
 * file at the path has a DIFFERENT one (the notebook was renamed away where no rename event was seen, and another notebook now sits at its old
 * path), the path is not trusted and the notebook is looked for by its id. That search reads the id of every notebook, so one resolver (one
 * dialog session) reads each notebook once and remembers the answers, including "nobody has this id".
 *
 * Resolving never writes. A caller that wants the bookmark to follow a moved notebook (an explicit open) does it itself, and only when `unique` says
 * exactly one notebook carries the id: with a sync conflict copy or a copy made in the file manager there is no telling which one is "the" notebook.
 */

export interface ResolveDeps<F extends { path: string }> {
	/** The notebook file at `path`, or null (no such file, or not a notebook). */
	fileAt(path: string): F | null;
	/** Every notebook, newest first. */
	notebooks(): F[];
	/** The notebook's own id from the start of its file, or null (unreadable, or none yet). */
	idOf(file: F): Promise<string | null>;
}

export interface BookmarkRef {
	path: string;
	docId: string;
}

export interface Resolved<F> {
	file: F;
	/** Found by its id, not at its path: the bookmark's path is out of date. */
	byId: boolean;
	/** Exactly one notebook carries the id (always true for a file found at the path). */
	unique: boolean;
}

export class BookmarkResolver<F extends { path: string }> {
	private ids = new Map<string, Promise<string | null>>();
	private index: Promise<Map<string, F[]>> | null = null;

	constructor(private readonly deps: ResolveDeps<F>) {}

	private idOf(file: F): Promise<string | null> {
		let p = this.ids.get(file.path);
		if (!p) {
			p = this.deps.idOf(file).catch(() => null);
			this.ids.set(file.path, p);
		}
		return p;
	}

	/** The notebooks by id, read once per resolver. */
	private byId(): Promise<Map<string, F[]>> {
		this.index ??= (async () => {
			const out = new Map<string, F[]>();
			for (const file of this.deps.notebooks()) {
				const id = await this.idOf(file);
				if (id) out.set(id, [...(out.get(id) ?? []), file]);
			}
			return out;
		})();
		return this.index;
	}

	async resolve(b: BookmarkRef): Promise<Resolved<F> | null> {
		const direct = this.deps.fileAt(b.path);
		if (direct) {
			if (!b.docId) return { file: direct, byId: false, unique: true };
			const id = await this.idOf(direct);
			// No id to compare (unreadable, or a notebook that has none yet): the path is all there is.
			if (id === null || id === b.docId) return { file: direct, byId: false, unique: true };
		}
		if (!b.docId) return null;
		const found = ((await this.byId()).get(b.docId) ?? []).filter((f) => f.path !== direct?.path);
		const first = found[0];
		return first ? { file: first, byId: true, unique: found.length === 1 } : null;
	}
}
