// 0.17 (#23): the PDF copy service on a small in-memory vault: what it writes, what it refuses to overwrite, how it follows renames and deletes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTFile, FakeTFolder } from "./fake-vault";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());
vi.stubGlobal("window", { setTimeout, clearTimeout });

const { PdfCopyService } = await import("../src/storage/pdf-copy-service");
const { PdfCopyStore } = await import("../src/storage/pdf-copy-store");
const { DEFAULT_SETTINGS } = await import("../src/settings");
const { createDocument } = await import("../src/model/document");
const { line } = await import("./helpers");
const { parseCopies } = await import("../src/storage/pdf-copy-logic");
const { sha256Hex } = await import("../src/pdf/hash");
import type { PdfCopySource } from "../src/storage/pdf-copy-service";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import type { NotebookSettings } from "../src/settings";

/** A vault of text and binary files, with the calls the service makes. */
class World {
	readonly bin = new Map<string, Uint8Array>();
	readonly text = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
	readonly writes: string[] = [];
	private readonly objects = new Map<string, FakeTFile>();

	private file(path: string): FakeTFile {
		let f = this.objects.get(path);
		if (!f) this.objects.set(path, (f = new FakeTFile(path)));
		f.stat.size = this.bin.get(path)?.length ?? this.text.get(path)?.length ?? 0;
		return f;
	}

	readonly vault = {
		getFileByPath: (p: string) => (this.bin.has(p) || this.text.has(p) ? this.file(p) : null),
		getAbstractFileByPath: (p: string) => (this.bin.has(p) || this.text.has(p) ? this.file(p) : this.folders.has(p) ? new FakeTFolder(p, null as never) : null),
		getFolderByPath: (p: string) => (this.folders.has(p) ? new FakeTFolder(p, null as never) : null),
		readBinary: async (f: { path: string }) => {
			const b = this.bin.get(f.path);
			if (!b) throw new Error("ENOENT");
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
		},
		createBinary: async (p: string, data: ArrayBuffer) => {
			if (this.bin.has(p) || this.text.has(p)) throw new Error("exists");
			this.writes.push(`create ${p}`);
			this.bin.set(p, new Uint8Array(data.slice(0)));
			return this.file(p);
		},
		modifyBinary: async (f: { path: string }, data: ArrayBuffer) => {
			this.writes.push(`modify ${f.path}`);
			this.bin.set(f.path, new Uint8Array(data.slice(0)));
		},
		createFolder: async (p: string) => void this.folders.add(p),
		on: (name: string, fn: (...a: unknown[]) => void) => {
			(this.handlers[name] ??= []).push(fn);
			return { name };
		},
	};

	readonly app = {
		vault: this.vault,
		workspace: { onLayoutReady: (fn: () => void) => fn() },
		fileManager: {
			renameFile: async (f: { path: string }, to: string) => {
				const from = f.path;
				this.writes.push(`rename ${from} -> ${to}`);
				const b = this.bin.get(from);
				if (b) {
					this.bin.delete(from);
					this.bin.set(to, b);
				}
				f.path = to;
			},
		},
		loadLocalStorage: () => null,
		saveLocalStorage: () => undefined,
	} as never;

	emit(name: string, ...args: unknown[]): void {
		for (const fn of this.handlers[name] ?? []) fn(...args);
	}
}

function memoryAdapter(files: Record<string, string>): DeviceFileAdapter {
	return {
		exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
		read: async (p) => files[p]!,
		write: async (p, d) => void (files[p] = d),
		mkdir: async () => undefined,
		list: async (folder) => Object.keys(files).filter((f) => f.startsWith(`${folder}/`)),
	};
}

const NB = "Notebooks/Maths.notebook";

function source(world: World, path = NB, strokes = 1): PdfCopySource {
	const doc = createDocument(new Date(2026, 0, 1));
	for (let i = 0; i < strokes; i++) doc.pages[0]!.strokes.push(line(10, 10 + i, 100, 90, 6, 2));
	void world;
	return {
		file: new FakeTFile(path) as never, doc, pages: doc.pages, options: {},
		stamp: () => 0, unsaved: () => false,
	};
}

describe("the PDF copy service", () => {
	let world: World;
	let sidecar: Record<string, string>;
	let settings: NotebookSettings;
	let service: InstanceType<typeof PdfCopyService>;
	let saved: number;

	beforeEach(() => {
		world = new World();
		sidecar = {};
		saved = 0;
		settings = { ...DEFAULT_SETTINGS, pdfCopyNotebooks: {}, pdfCopy: true };
		const store = new PdfCopyStore(memoryAdapter(sidecar), () => "Notebooks", "0000000a");
		service = new PdfCopyService({ app: world.app, settings: () => settings, saveSettings: async () => void saved++, store, mobile: false });
		service.register({ registerEvent: () => undefined, register: () => undefined } as never);
	});

	const settle = async (): Promise<void> => {
		await vi.waitFor(() => expect((service as unknown as { running: Set<string> }).running.size).toBe(0), { timeout: 20_000 });
		await new Promise((r) => window.setTimeout(r, 20));
		await vi.waitFor(() => expect((service as unknown as { running: Set<string> }).running.size).toBe(0));
	};

	it("writes the copy next to the notebook, records it, and shows when", async () => {
		service.closing(NB, source(world));
		await vi.waitFor(() => expect(world.bin.has("Notebooks/Maths.pdf")).toBe(true), { timeout: 20_000 });
		await settle();
		const bytes = world.bin.get("Notebooks/Maths.pdf")!;
		expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe("%PDF-");
		const own = parseCopies(sidecar["Notebooks/_meta/pdfcopy-0000000a.json"]!);
		expect(own.ok && own.data.copies[NB]).toMatchObject({ pdf: "Notebooks/Maths.pdf", size: bytes.length, hash: await sha256Hex(bytes.buffer.slice(0) as ArrayBuffer) });
		expect(service.status(NB).kind).toBe("updated");
		expect(service.statusText(NB)).toMatch(/^PDF copy updated \d\d:\d\d$/);
	});

	it("does nothing when the copy is off, for a notebook without a choice", async () => {
		settings.pdfCopy = false;
		service.closing(NB, source(world));
		await new Promise((r) => window.setTimeout(r, 50));
		expect(world.writes).toEqual([]);
		expect(service.status(NB).kind).toBe("off");
	});

	it("skips an unchanged notebook, and replaces its own copy when the notebook changed", async () => {
		const same = source(world);
		service.closing(NB, same);
		await vi.waitFor(() => expect(world.writes).toHaveLength(1), { timeout: 20_000 });
		await settle();
		service.closing(NB, same);
		await new Promise((r) => window.setTimeout(r, 300));
		await settle();
		expect(world.writes).toEqual(["create Notebooks/Maths.pdf"]);
		same.doc.pages[0]!.strokes.push(line(5, 5, 50, 50, 6, 2));
		service.closing(NB, same);
		await vi.waitFor(() => expect(world.writes).toHaveLength(2), { timeout: 20_000 });
		expect(world.writes[1]).toBe("modify Notebooks/Maths.pdf");
	});

	it("never overwrites a PDF of the user's: the copy goes to a new name", async () => {
		const mine = new Uint8Array([1, 2, 3, 4]);
		world.bin.set("Notebooks/Maths.pdf", mine);
		service.closing(NB, source(world));
		await vi.waitFor(() => expect(world.bin.has("Notebooks/Maths (copy 2).pdf")).toBe(true), { timeout: 20_000 });
		await settle();
		expect(world.bin.get("Notebooks/Maths.pdf")).toBe(mine);
		expect(world.writes).toEqual(["create Notebooks/Maths (copy 2).pdf"]);
	});

	it("treats a copy the user changed as theirs", async () => {
		service.closing(NB, source(world));
		await vi.waitFor(() => expect(world.writes).toHaveLength(1), { timeout: 20_000 });
		await settle();
		const edited = new Uint8Array(world.bin.get("Notebooks/Maths.pdf")!);
		edited[edited.length - 10] = edited[edited.length - 10]! ^ 0xff; // same size, other bytes
		world.bin.set("Notebooks/Maths.pdf", edited);
		service.closing(NB, source(world, NB, 3));
		await vi.waitFor(() => expect(world.bin.has("Notebooks/Maths (copy 2).pdf")).toBe(true), { timeout: 20_000 });
		expect(world.bin.get("Notebooks/Maths.pdf")).toBe(edited);
		expect(world.writes).not.toContain("modify Notebooks/Maths.pdf");
	});

	it("does not write a copy of a notebook that is edited while it is built", async () => {
		let tick = 0;
		const src = { ...source(world), stamp: () => tick, unsaved: () => false };
		const original = src.pages;
		Object.defineProperty(src, "pages", { get: () => (tick++, original) });
		service.closing(NB, src);
		await new Promise((r) => window.setTimeout(r, 400));
		await settle();
		expect(world.writes).toEqual([]);
	});

	it("follows a renamed notebook, and leaves the copy when the notebook is deleted", async () => {
		service.closing(NB, source(world));
		await vi.waitFor(() => expect(world.writes).toHaveLength(1), { timeout: 20_000 });
		await settle();
		settings.pdfCopyNotebooks = { [NB]: true };
		// The service registers through the Plugin API; call its handlers directly.
		const priv = service as unknown as { onRename(n: string, o: string, f: boolean): Promise<void>; onDelete(p: string, f: boolean): Promise<void> };
		await priv.onRename("Notebooks/Algebra.notebook", NB, false);
		expect(world.bin.has("Notebooks/Algebra.pdf")).toBe(true);
		expect(world.bin.has("Notebooks/Maths.pdf")).toBe(false);
		expect(settings.pdfCopyNotebooks).toEqual({ "Notebooks/Algebra.notebook": true });
		expect(service.status("Notebooks/Algebra.notebook").kind).toBe("updated");
		await priv.onDelete("Notebooks/Algebra.notebook", false);
		expect(world.bin.has("Notebooks/Algebra.pdf")).toBe(true);
		expect(service.status("Notebooks/Algebra.notebook").kind).toBe("stopped");
	});

	it("does not rename a copy the user changed", async () => {
		service.closing(NB, source(world));
		await vi.waitFor(() => expect(world.writes).toHaveLength(1), { timeout: 20_000 });
		await settle();
		const edited = new Uint8Array(world.bin.get("Notebooks/Maths.pdf")!);
		edited[edited.length - 10] = edited[edited.length - 10]! ^ 0xff;
		world.bin.set("Notebooks/Maths.pdf", edited);
		const priv = service as unknown as { onRename(n: string, o: string, f: boolean): Promise<void> };
		await priv.onRename("Notebooks/Algebra.notebook", NB, false);
		expect(world.bin.get("Notebooks/Maths.pdf")).toBe(edited);
		expect(world.writes.filter((w) => w.startsWith("rename"))).toEqual([]);
	});

	it("stops updating a notebook that went into the library trash", async () => {
		service.closing(NB, source(world));
		await vi.waitFor(() => expect(world.writes).toHaveLength(1), { timeout: 20_000 });
		await settle();
		const priv = service as unknown as { onRename(n: string, o: string, f: boolean): Promise<void> };
		await priv.onRename("Notebooks/_trash/items/abc/Maths.notebook", NB, false);
		expect(world.bin.has("Notebooks/Maths.pdf")).toBe(true);
		expect(service.status(NB).kind).toBe("stopped");
		expect(service.enabled("Notebooks/_trash/items/abc/Maths.notebook")).toBe(false);
	});

	it("turns the copy on from the notebook menu and builds it", async () => {
		settings.pdfCopy = false;
		await service.setEnabled(NB, true, () => source(world));
		expect(settings.pdfCopyNotebooks).toEqual({ [NB]: true });
		expect(saved).toBe(1);
		await vi.waitFor(() => expect(world.bin.has("Notebooks/Maths.pdf")).toBe(true), { timeout: 20_000 });
		await settle();
		await service.setEnabled(NB, false, () => source(world));
		expect(settings.pdfCopyNotebooks).toEqual({});
		expect(service.status(NB).kind).toBe("off");
	});

	it("reports a failure in the status line and keeps the notebook untouched", async () => {
		const bad = { ...source(world), options: { header: () => { throw new Error("boom"); } } };
		service.closing(NB, bad);
		await vi.waitFor(() => expect(service.status(NB).kind).toBe("failed"), { timeout: 20_000 });
		expect(service.statusText(NB)).toContain("boom");
		expect(world.writes).toEqual([]);
	});
});
