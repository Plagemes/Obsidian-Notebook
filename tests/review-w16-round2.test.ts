/** 0.16 re-review fixes, round 2 (D1 - D4; D5 is in review-w16-inbox.test.ts). */
import { describe, expect, it, vi } from "vitest";
import { DIGEST_END, DIGEST_START, canRewritePicture, stableDigestPictureName } from "../src/model/highlight-digest";
import { mayDiscardAsset } from "../src/library/bulk-discard";
import { runBulkImport, type BulkControl, type BulkJob, type BulkRunDeps } from "../src/library/bulk-import-run";
import type { NotebookDocument } from "../src/model/types";
import { FakeTFile } from "./fake-vault";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());
const { storePicture, findOwnDigestCopy } = await import("../src/view/highlight-digest");

const NOTE = "Maths/Maths — Highlights.md";
const NAME = "Maths highlight p1-1.png";

/** A small vault: binary files (number arrays) and text files (strings), with link resolution by path. */
function vaultRig(files: Record<string, string | number[]>, backlinks: Record<string, Record<string, number>> = {}) {
	const bytes = new Map<string, ArrayBuffer>();
	const tfiles = new Map<string, FakeTFile>();
	const texts = new Map<string, string>();
	for (const [p, b] of Object.entries(files)) {
		tfiles.set(p, new FakeTFile(p));
		if (Array.isArray(b)) bytes.set(p, new Uint8Array(b).buffer);
		else texts.set(p, b);
	}
	const created: string[] = [];
	const writes: string[] = [];
	const app = {
		vault: {
			getFileByPath: (p: string) => tfiles.get(p) ?? null,
			getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
			read: async (f: FakeTFile) => texts.get(f.path) ?? "",
			readBinary: async (f: FakeTFile) => bytes.get(f.path)!,
			modifyBinary: async (f: FakeTFile, d: ArrayBuffer) => void (bytes.set(f.path, d), writes.push(f.path)),
			createBinary: async (p: string, d: ArrayBuffer) => {
				const f = new FakeTFile(p);
				tfiles.set(p, f);
				bytes.set(p, d);
				created.push(p);
				return f;
			},
			createFolder: async () => undefined,
		},
		metadataCache: {
			resolvedLinks: backlinks,
			getFirstLinkpathDest: (link: string) => tfiles.get(link) ?? null,
		},
		fileManager: {
			getAvailablePathForAttachment: async (name: string) => {
				let path = `Maths/att/${name}`;
				for (let i = 1; tfiles.has(path); i++) path = `Maths/att/${name.replace(/\.png$/, "")} ${i}.png`;
				return path;
			},
			generateMarkdownLink: (f: FakeTFile) => `[[${f.path}]]`,
		},
		loadLocalStorage: () => null,
		saveLocalStorage: () => undefined,
	};
	return { app: app as unknown as Parameters<typeof storePicture>[0], created, writes };
}
const png = (...b: number[]) => new Blob([new Uint8Array(b)]);

describe("D1: a held plain name does not make a new copy on every run", () => {
	it("strips only Obsidian's numeric suffix of a digest picture name", () => {
		expect(stableDigestPictureName("Maths highlight p1-1 2.png")).toBe("maths highlight p1-1.png");
		expect(stableDigestPictureName("Maths highlight p1-1.png")).toBe("maths highlight p1-1.png");
		expect(stableDigestPictureName("Notes 2 highlight p1-1.png")).toBe("notes 2 highlight p1-1.png");
		expect(stableDigestPictureName("Holiday 2.png")).toBe("holiday 2.png");
	});

	it("canRewritePicture accepts the suffixed copy of the same picture only", () => {
		const c = { foundPath: "Maths/att/Maths highlight p1-1 1.png", name: NAME, expectedDir: "Maths/att", notePath: NOTE, linkedFrom: [NOTE] };
		expect(canRewritePicture(c)).toBe(true);
		expect(canRewritePicture({ ...c, foundPath: "Maths/att/Maths highlight p2-1 1.png" })).toBe(false);
	});

	it("repeated runs keep rewriting the same suffixed file", async () => {
		// The plain name is held by a picture another note uses, so an earlier run made "... 1.png".
		const held = `Maths/att/${NAME}`;
		const mine = "Maths/att/Maths highlight p1-1 1.png";
		const s = vaultRig({ [held]: [7], [mine]: [1, 2, 3] }, { "Other/Essay.md": { [held]: 1 }, [NOTE]: { [mine]: 1 } });
		const known = new Map([["maths highlight p1-1 1.png", mine]]);
		await storePicture(s.app, NOTE, NAME, png(9, 9, 9), known);
		await storePicture(s.app, NOTE, NAME, png(8, 8, 8), known);
		expect(s.created).toEqual([]);
		expect(s.writes).toEqual([mine, mine]);
	});
});

describe("D2: a note made by 'Use a new note' is remembered", () => {
	const section = `${DIGEST_START}\nold\n${DIGEST_END}`;

	it("finds the first Highlights N note that holds the digest section", async () => {
		const s = vaultRig({
			"Maths/Maths — Highlights 2.md": "My own text, no markers",
			"Maths/Maths — Highlights 3.md": `# T\n\n${section}\n`,
		});
		const own = await findOwnDigestCopy(s.app, NOTE);
		expect(own?.file.path).toBe("Maths/Maths — Highlights 3.md");
		expect(own?.text).toContain(DIGEST_START);
	});

	it("finds nothing when there is no such note or its markers are unpaired", async () => {
		expect(await findOwnDigestCopy(vaultRig({}).app, NOTE)).toBeNull();
		const broken = vaultRig({ "Maths/Maths — Highlights 2.md": `x ${DIGEST_START} no end` });
		expect(await findOwnDigestCopy(broken.app, NOTE)).toBeNull();
	});
});

describe("D3: a stored copy a notebook names is never discarded", () => {
	const id = "ab".repeat(32);
	const nb = (text: string) => ({ read: async () => text });
	const parsedLike = (s: string) => JSON.stringify({ format: "notebook", version: 14, pages: [], note: s });

	it("allows the discard when no notebook names the id", async () => {
		expect(await mayDiscardAsset(id, [nb(parsedLike("nothing here")), nb(parsedLike("cd".repeat(32)))])).toBe(true);
		expect(await mayDiscardAsset(id, [])).toBe(true);
	});

	it("refuses when a notebook names it, even one that does not parse", async () => {
		expect(await mayDiscardAsset(id, [nb(parsedLike(id))])).toBe(false);
		expect(await mayDiscardAsset(id, [nb(`{"cut off": "${id}`)])).toBe(false);
	});

	it("refuses while a notebook is still being downloaded or cannot be read", async () => {
		expect(await mayDiscardAsset(id, [nb("")])).toBe(false);
		expect(await mayDiscardAsset(id, [nb("\0\0\0\0")])).toBe(false);
		expect(await mayDiscardAsset(id, [{ read: async () => { throw new Error("gone"); } }])).toBe(false);
	});
});

describe("D4: a failed create that left a notebook file keeps the copies", () => {
	const PDF = new TextEncoder().encode("%PDF-1.7\n");
	const source = { name: "A.pdf", size: PDF.length, type: "", head: async () => PDF, read: async () => PDF.slice().buffer };
	const job: BulkJob = { key: "f0", kind: "pdf", name: "A", files: [{ fileName: "A.pdf", source }] };
	const ctl: BulkControl = { cancelled: () => false, onProgress: () => undefined };
	const make = (exists: BulkRunDeps<string>["notebookExists"]) => {
		const trashed: string[] = [];
		const deps: BulkRunDeps<string> = {
			store: async (b, name, kind) => ({ id: "1".repeat(64), kind, path: `_assets/${name}`, name, bytes: b.byteLength }),
			discard: async (a) => void trashed.push(a.path),
			pdfSizes: async () => [{ width: 595, height: 842 }],
			imageSize: async () => ({ width: 10, height: 10 }),
			create: async (_f, _n, doc: NotebookDocument) => {
				void doc;
				throw new Error("disk full");
			},
			notebookExists: exists,
			artStyle: () => "waves",
			yieldToUi: () => Promise.resolve(),
		};
		return { deps, trashed };
	};

	it("discards when nothing exists at the target after the failure", async () => {
		const r = make(() => false);
		await runBulkImport([job], "N", { paper: "blank", cover: null }, r.deps, ctl);
		expect(r.trashed).toEqual(["_assets/A.pdf"]);
	});

	it("keeps the copies when a notebook file is there, or the question cannot be answered", async () => {
		const there = make(async () => true);
		await runBulkImport([job], "N", { paper: "blank", cover: null }, there.deps, ctl);
		expect(there.trashed).toEqual([]);
		const unknown = make(async () => {
			throw new Error("?");
		});
		await runBulkImport([job], "N", { paper: "blank", cover: null }, unknown.deps, ctl);
		expect(unknown.trashed).toEqual([]);
	});
});
