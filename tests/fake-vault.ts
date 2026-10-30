/**
 * A small in-memory vault for storage tests. Use together with `obsidianMock()` in `vi.mock("obsidian", ...)`, so that
 * `instanceof TFile` / `TFolder` in the code under test sees the classes made here.
 */

export class FakeTFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.slice(this.path.lastIndexOf("/") + 1);
	}
	get basename(): string {
		return this.name.replace(/\.[^.]+$/, "");
	}
	get extension(): string {
		const i = this.name.lastIndexOf(".");
		return i > 0 ? this.name.slice(i + 1) : "";
	}
	stat = { mtime: 0, ctime: 0, size: 0 };
}

export class FakeTFolder {
	constructor(public path: string, private readonly vault: FakeVault) {}
	get name(): string {
		return this.path.slice(this.path.lastIndexOf("/") + 1);
	}
	get children(): Array<FakeTFile | FakeTFolder> {
		return this.vault.childrenOf(this.path);
	}
	isRoot(): boolean {
		return this.path === "/" || this.path === "";
	}
}

export function obsidianMock(): Record<string, unknown> {
	class Notice {
		static shown: string[] = [];
		constructor(message: string) {
			Notice.shown.push(message);
		}
	}
	class Modal {
		contentEl = {};
		constructor(public app: unknown) {}
		open(): void {}
		close(): void {}
	}
	return {
		TFile: FakeTFile,
		TFolder: FakeTFolder,
		Notice,
		Modal,
		Setting: class {},
		FuzzySuggestModal: Modal,
		SuggestModal: Modal,
		AbstractInputSuggest: class {},
		Menu: class {},
		Component: class {},
		ItemView: class {},
		TextFileView: class {},
		FileView: class {},
		Scope: class {},
		Vault: { recurseChildren: () => undefined },
		loadPdfJs: async () => ({}),
		requestUrl: async () => ({}),
		parseLinktext: (s: string) => ({ path: s, subpath: "" }),
		moment: () => ({}),
		Platform: { isMobile: false },
		getLanguage: () => "en",
		setIcon: () => undefined,
		normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "") || "/",
	};
}

export class FakeVault {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly log: string[] = [];
	private readonly fileObjects = new Map<string, FakeTFile>();
	/** Paths whose next `create` fails (simulates a full disk or a sync lock). */
	readonly failCreate = new Set<string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [p, text] of Object.entries(initial)) this.put(p, text);
	}

	put(path: string, text: string): void {
		this.files.set(path, text);
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
	}

	private fileFor(path: string): FakeTFile {
		let f = this.fileObjects.get(path);
		if (!f) {
			f = new FakeTFile(path);
			this.fileObjects.set(path, f);
		}
		return f;
	}

	childrenOf(folder: string): Array<FakeTFile | FakeTFolder> {
		const prefix = folder === "" || folder === "/" ? "" : `${folder}/`;
		const out: Array<FakeTFile | FakeTFolder> = [];
		for (const p of this.files.keys()) if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) out.push(this.fileFor(p));
		for (const p of this.folders) if (p.startsWith(prefix) && p !== folder && !p.slice(prefix.length).includes("/")) out.push(new FakeTFolder(p, this));
		return out;
	}

	readonly vault = {
		getFileByPath: (p: string) => (this.files.has(p) ? this.fileFor(p) : null),
		getFolderByPath: (p: string) => (this.folders.has(p) || p === "/" || p === "" ? new FakeTFolder(p, this) : null),
		getAbstractFileByPath: (p: string) => (this.files.has(p) ? this.fileFor(p) : this.folders.has(p) ? new FakeTFolder(p, this) : null),
		read: async (f: { path: string }) => {
			const text = this.files.get(f.path);
			if (text === undefined) throw new Error(`ENOENT ${f.path}`);
			return text;
		},
		create: async (p: string, text: string) => {
			if (this.failCreate.has(p)) {
				this.failCreate.delete(p);
				throw new Error("disk full");
			}
			if (this.files.has(p)) throw new Error("File already exists.");
			this.log.push(`create ${p}`);
			this.put(p, text);
			return this.fileFor(p);
		},
		modify: async (f: { path: string }, text: string) => {
			this.log.push(`modify ${f.path}`);
			this.files.set(f.path, text);
		},
		process: async (f: { path: string }, fn: (data: string) => string) => {
			const before = this.files.get(f.path) ?? "";
			const after = fn(before);
			if (after !== before) this.log.push(`modify ${f.path}`);
			this.files.set(f.path, after);
			return after;
		},
		delete: async (f: { path: string }) => {
			this.log.push(`delete ${f.path}`);
			this.files.delete(f.path);
			for (const p of [...this.files.keys()]) if (p.startsWith(`${f.path}/`)) this.files.delete(p);
			this.folders.delete(f.path);
		},
		createFolder: async (p: string) => {
			this.folders.add(p);
		},
		rename: async (f: { path: string }, to: string) => {
			this.log.push(`rename ${f.path} -> ${to}`);
			const text = this.files.get(f.path);
			if (text !== undefined) {
				this.files.delete(f.path);
				this.put(to, text);
			}
		},
	};

	get app(): never {
		return { vault: this.vault, fileManager: { trashFile: async (f: { path: string }) => this.vault.delete(f) } } as never;
	}
}
