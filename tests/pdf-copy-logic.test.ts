// 0.17 (#23): the optional PDF copy: settings, paths, what may be overwritten, the record, the fingerprint, following the notebook.
import { describe, expect, it } from "vitest";
import { pagesToPdf, pagesToPdfYielding } from "../src/ink/export-pdf";
import { createPage } from "../src/model/document";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { settingSpecs } from "../src/view/settings-schema";
import {
	alternativePath, chooseTarget, clockText, cleanFolder, copyBasePath, copyEnabled, DEFAULT_PDF_COPY_SETTINGS, emptyCopies, fingerprintText, isOurs, KeyedTimers,
	looksLikePdf, MAX_ALTERNATIVES, MAX_PDF_COPY_OVERRIDES, mergeCopies, moveCopyFile, moveOverrides, movedPath, moveRecords, normaliseOverrides, parseCopies,
	readPdfCopySettings, renamedCopyPath, resolveWhen, serializeCopies, statusOf, stopRecord, withNotebookChoice, type CopyRecord, type Occupant,
} from "../src/storage/pdf-copy-logic";
import { PdfCopyBlockedError, PdfCopyStore } from "../src/storage/pdf-copy-store";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import { line } from "./helpers";

const HASH = "a".repeat(64);
const rec = (over: Partial<CopyRecord> = {}): CopyRecord => ({ notebook: "NB/Maths.notebook", pdf: "NB/Maths.pdf", hash: HASH, size: 100, fingerprint: "f1", at: 1_000, ...over });

describe("settings", () => {
	it("is off by default and reads leniently", () => {
		expect(DEFAULT_SETTINGS.pdfCopy).toBe(false);
		expect(readSettings({}).pdfCopy).toBe(false);
		const s = readPdfCopySettings({ pdfCopy: true, pdfCopyFolder: " /Shared//PDF/../ ", pdfCopyWhen: "close", pdfCopyNotebooks: { "a.notebook": true, "b.notebook": "yes", "": true } });
		expect(s).toEqual({ pdfCopy: true, pdfCopyFolder: "Shared/PDF", pdfCopyWhen: "close", pdfCopyNotebooks: { "a.notebook": true } });
		expect(readPdfCopySettings({ pdfCopy: "on", pdfCopyWhen: "sometimes", pdfCopyNotebooks: [1] })).toEqual(DEFAULT_PDF_COPY_SETTINGS);
	});

	it("keeps the defaults object unshared between reads", () => {
		const a = readSettings({});
		a.pdfCopyNotebooks["x.notebook"] = true;
		expect(readSettings({}).pdfCopyNotebooks).toEqual({});
		expect(DEFAULT_SETTINGS.pdfCopyNotebooks).toEqual({});
	});

	it("bounds the overrides", () => {
		const many = Object.fromEntries(Array.from({ length: MAX_PDF_COPY_OVERRIDES + 20 }, (_, i) => [`n${i}.notebook`, true]));
		expect(Object.keys(normaliseOverrides(many))).toHaveLength(MAX_PDF_COPY_OVERRIDES);
	});

	it("lets a notebook override the global switch, and drops an override that says the same", () => {
		const off = { pdfCopy: false, pdfCopyNotebooks: {} };
		expect(copyEnabled(off, "a.notebook")).toBe(false);
		const on1 = { ...off, pdfCopyNotebooks: withNotebookChoice(off, "a.notebook", true) };
		expect(copyEnabled(on1, "a.notebook")).toBe(true);
		expect(copyEnabled(on1, "b.notebook")).toBe(false);
		expect(withNotebookChoice(on1, "a.notebook", false)).toEqual({});
		const global = { pdfCopy: true, pdfCopyNotebooks: {} };
		expect(withNotebookChoice(global, "a.notebook", false)).toEqual({ "a.notebook": false });
		expect(copyEnabled({ ...global, pdfCopyNotebooks: { "a.notebook": false } }, "a.notebook")).toBe(false);
		expect(copyEnabled({ pdfCopy: false, pdfCopyNotebooks: {} }, "toString")).toBe(false);
	});

	it("is cheap on a phone or tablet", () => {
		expect(resolveWhen("auto", true)).toBe("close");
		expect(resolveWhen("auto", false)).toBe("idle");
		expect(resolveWhen("idle", true)).toBe("idle");
		expect(resolveWhen("close", false)).toBe("close");
	});

	it("is a row of the settings tab for each of its keys", () => {
		const ids = settingSpecs().map((s) => s.id);
		for (const id of ["pdfCopy", "pdfCopyWhen", "pdfCopyFolder"]) expect(ids).toContain(id);
	});
});

describe("paths", () => {
	it("puts the copy next to the notebook or in the configured folder", () => {
		expect(copyBasePath("Notebooks/Maths.notebook", "")).toBe("Notebooks/Maths.pdf");
		expect(copyBasePath("Maths.notebook", "")).toBe("Maths.pdf");
		expect(copyBasePath("Notebooks/Maths.notebook", "/Shared/PDF/")).toBe("Shared/PDF/Maths.pdf");
		expect(alternativePath("A/Maths.pdf", 2)).toBe("A/Maths (copy 2).pdf");
		expect(cleanFolder("../x/./y/")).toBe("x/y");
	});

	it("follows a renamed or moved notebook, keeping a copy suffix", () => {
		expect(renamedCopyPath("A/Maths.notebook", "A/Algebra.notebook", "A/Maths.pdf", "")).toBe("A/Algebra.pdf");
		expect(renamedCopyPath("A/Maths.notebook", "B/Maths.notebook", "A/Maths.pdf", "")).toBe("B/Maths.pdf");
		expect(renamedCopyPath("A/Maths.notebook", "B/Algebra.notebook", "A/Maths (copy 2).pdf", "")).toBe("B/Algebra (copy 2).pdf");
		// A configured folder stays where it is.
		expect(renamedCopyPath("A/Maths.notebook", "B/Algebra.notebook", "Shared/Maths.pdf", "Shared")).toBe("Shared/Algebra.pdf");
		// A copy whose name does not come from the notebook is left alone.
		expect(renamedCopyPath("A/Maths.notebook", "A/Algebra.notebook", "A/Report.pdf", "")).toBeNull();
	});

	it("moves paths inside a moved folder only", () => {
		expect(movedPath("A/x.notebook", "A", "B")).toBe("B/x.notebook");
		expect(movedPath("A", "A", "B")).toBe("B");
		expect(movedPath("AB/x.notebook", "A", "B")).toBeNull();
		expect(moveOverrides({ "A/x.notebook": true, "C/y.notebook": false }, "A", "B")).toEqual({ "B/x.notebook": true, "C/y.notebook": false });
	});
});

describe("which file may be written", () => {
	const world = (files: Record<string, Occupant>) => async (p: string): Promise<Occupant> => files[p] ?? "none";

	it("creates the copy at the plain name when it is free", async () => {
		expect(await chooseTarget("A/Maths.pdf", null, world({}))).toEqual({ path: "A/Maths.pdf", overwrite: false, diverted: false });
	});

	it("replaces the recorded copy while it is still exactly what was written", async () => {
		expect(await chooseTarget("A/Maths.pdf", "A/Maths.pdf", world({ "A/Maths.pdf": "ours" }))).toEqual({ path: "A/Maths.pdf", overwrite: true, diverted: false });
		expect(await chooseTarget("A/Maths.pdf", "A/Maths (copy 2).pdf", world({ "A/Maths.pdf": "foreign", "A/Maths (copy 2).pdf": "ours" })))
			.toEqual({ path: "A/Maths (copy 2).pdf", overwrite: true, diverted: true });
	});

	it("never overwrites a file that is not ours: it goes to the next free name", async () => {
		// The user's own Maths.pdf.
		expect(await chooseTarget("A/Maths.pdf", null, world({ "A/Maths.pdf": "foreign" }))).toEqual({ path: "A/Maths (copy 2).pdf", overwrite: false, diverted: true });
		// The copy was edited by the user (recorded, but the hash no longer matches), so it counts as theirs now.
		expect(await chooseTarget("A/Maths.pdf", "A/Maths.pdf", world({ "A/Maths.pdf": "foreign" }))).toEqual({ path: "A/Maths (copy 2).pdf", overwrite: false, diverted: true });
		expect(await chooseTarget("A/Maths.pdf", null, world({ "A/Maths.pdf": "foreign", "A/Maths (copy 2).pdf": "foreign" }))).toEqual({ path: "A/Maths (copy 3).pdf", overwrite: false, diverted: true });
	});

	it("gives up, writing nothing, when every name is taken", async () => {
		let asked = 0;
		expect(await chooseTarget("A/Maths.pdf", null, async () => (asked++, "foreign"))).toBeNull();
		expect(asked).toBe(MAX_ALTERNATIVES);
	});

	it("recognises its own file only by path, size and hash together", () => {
		const records = [rec()];
		expect(isOurs(records, "NB/Maths.pdf", 100, HASH)).toBe(true);
		expect(isOurs(records, "NB/Maths.pdf", 101, HASH)).toBe(false);
		expect(isOurs(records, "NB/Maths.pdf", 100, "b".repeat(64))).toBe(false);
		expect(isOurs(records, "NB/Other.pdf", 100, HASH)).toBe(false);
		expect(isOurs([], "NB/Maths.pdf", 100, HASH)).toBe(false);
	});
});

describe("the record file", () => {
	it("round-trips, keeping unknown fields", () => {
		const text = JSON.stringify({ version: 1, future: { a: 1 }, copies: { "NB/Maths.notebook": { ...rec(), colour: "red" }, bad: { pdf: 3 }, "": rec() } });
		const parsed = parseCopies(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(Object.keys(parsed.data.copies)).toEqual(["NB/Maths.notebook"]);
		const back = parseCopies(serializeCopies(parsed.data));
		expect(back.ok && back.data).toEqual(parsed.data);
		expect(JSON.parse(serializeCopies(parsed.data))).toMatchObject({ future: { a: 1 }, copies: { "NB/Maths.notebook": { colour: "red", hash: HASH } } });
	});

	it("refuses broken, wrong-shaped and newer files", () => {
		expect(parseCopies("{oops")).toMatchObject({ ok: false, reason: "json" });
		expect(parseCopies("[1]")).toMatchObject({ ok: false, reason: "format" });
		expect(parseCopies('{"version":2,"copies":{}}')).toMatchObject({ ok: false, reason: "future" });
		expect(parseCopies('{"copies":{"a":{"notebook":"a","pdf":"a.pdf","hash":"nothex","size":1,"at":1}}}')).toMatchObject({ ok: true, data: { copies: {} } });
	});

	it("merges devices by newest write and moves records with the notebook or the copy", () => {
		const a = { ...emptyCopies(), copies: { n: rec({ at: 1, fingerprint: "old" }) } };
		const b = { ...emptyCopies(), copies: { n: rec({ at: 2, fingerprint: "new" }), m: rec({ notebook: "m", pdf: "m.pdf" }) } };
		expect(mergeCopies([a, b]).n!.fingerprint).toBe("new");
		expect(mergeCopies([b, a]).n!.fingerprint).toBe("new");
		const moved = moveRecords({ ...emptyCopies(), copies: { "A/x.notebook": rec({ notebook: "A/x.notebook", pdf: "A/x.pdf" }) } }, "A", "B");
		expect(moved.copies["B/x.notebook"]).toMatchObject({ notebook: "B/x.notebook", pdf: "A/x.pdf" });
		const files = moveCopyFile(moved, "A", "B");
		expect(files.copies["B/x.notebook"]!.pdf).toBe("B/x.pdf");
		const stopped = stopRecord(files, "B/x.notebook");
		expect(stopped.copies["B/x.notebook"]!.stopped).toBe(true);
		expect(stopRecord(stopped, "missing")).toBe(stopped);
		expect(parseCopies(serializeCopies(stopped))).toMatchObject({ ok: true, data: { copies: { "B/x.notebook": { stopped: true } } } });
	});
});

describe("the fingerprint and the PDF check", () => {
	it("changes with a page, the title, the headers and the page count, and not otherwise", () => {
		const base = { title: "T", headers: "", pageCount: 2 };
		const f = (hashes: string[], extra = base) => fingerprintText(hashes, extra);
		expect(f(["a", "b"])).toBe(f(["a", "b"]));
		expect(f(["a", "b"])).not.toBe(f(["a", "c"]));
		expect(f(["a", "b"])).not.toBe(f(["a", "b"], { ...base, title: "U" }));
		expect(f(["a", "b"])).not.toBe(f(["a", "b"], { ...base, headers: "[1]" }));
		expect(f(["a", "b"])).not.toBe(f(["a", "b"], { ...base, pageCount: 3 }));
	});

	it("accepts a PDF of the writer and rejects a cut one", () => {
		const page = createPage({ width: 200, height: 300 }, { kind: "grid", spacing: 20 });
		page.strokes.push(line(10, 10, 100, 100, 8, 3));
		const bytes = pagesToPdf([page]);
		expect(looksLikePdf(bytes)).toBe(true);
		expect(looksLikePdf(bytes.subarray(0, bytes.length - 20))).toBe(false);
		expect(looksLikePdf(new Uint8Array(0))).toBe(false);
	});

	it("builds the same bytes page by page, pausing between pages", async () => {
		const pages = [0, 1, 2].map((i) => {
			const p = createPage({ width: 200, height: 300 }, { kind: "ruled", spacing: 20 });
			p.strokes.push(line(10, 10 + i, 100, 100, 8, 3));
			return p;
		});
		let pauses = 0;
		const slow = await pagesToPdfYielding(pages, { title: "T" }, async () => void pauses++);
		const fast = pagesToPdf(pages, { title: "T" });
		expect(slow.length).toBe(fast.length);
		expect(slow.every((b, i) => b === fast[i])).toBe(true);
		expect(pauses).toBeGreaterThanOrEqual(pages.length);
	});
});

describe("the status line", () => {
	it("tells what happened", () => {
		expect(statusOf(false, undefined, null)).toEqual({ kind: "off" });
		expect(statusOf(true, undefined, null)).toEqual({ kind: "waiting" });
		expect(statusOf(true, rec(), null)).toEqual({ kind: "updated", at: 1_000 });
		expect(statusOf(true, rec({ stopped: true }), null)).toEqual({ kind: "stopped", at: 1_000 });
		expect(statusOf(true, rec(), "boom")).toEqual({ kind: "failed", message: "boom" });
		expect(statusOf(false, rec(), null)).toEqual({ kind: "off" });
	});

	it("shows hh:mm", () => {
		const d = new Date(2026, 10, 4, 9, 5);
		expect(clockText(d.getTime())).toBe("09:05");
	});
});

describe("timers", () => {
	it("restarts a key's timer, cancels it, and fires once", () => {
		const queue: Array<{ id: number; fn: () => void }> = [];
		let next = 1;
		const timers = new KeyedTimers({
			set: (fn) => (queue.push({ id: next, fn }), next++),
			clear: (h) => void queue.splice(queue.findIndex((q) => q.id === h), 1),
		});
		const fired: string[] = [];
		timers.schedule("a", 30_000, () => fired.push("a1"));
		timers.schedule("a", 30_000, () => fired.push("a2"));
		timers.schedule("b", 30_000, () => fired.push("b"));
		expect(queue).toHaveLength(2);
		timers.cancel("b");
		expect(timers.has("b")).toBe(false);
		queue.shift()!.fn();
		expect(fired).toEqual(["a2"]);
		expect(timers.has("a")).toBe(false);
		timers.schedule("c", 1, () => fired.push("c"));
		timers.clearAll();
		expect(queue).toHaveLength(0);
	});
});

/** An in-memory vault folder for the record store. */
function memoryAdapter(files: Record<string, string> = {}): DeviceFileAdapter & { files: Record<string, string> } {
	return {
		files,
		exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
		read: async (p) => {
			if (!(p in files)) throw new Error("missing");
			return files[p]!;
		},
		write: async (p, d) => void (files[p] = d),
		mkdir: async () => undefined,
		list: async (folder) => Object.keys(files).filter((f) => f.startsWith(`${folder}/`) && !f.slice(folder.length + 1).includes("/")),
	};
}

describe("the record store", () => {
	const folder = "Notebooks/_meta";
	const own = `${folder}/pdfcopy-0000000a.json`;

	it("writes only this device's file and reads every device's", async () => {
		const other = serializeCopies({ ...emptyCopies(), copies: { "x.notebook": rec({ notebook: "x.notebook", pdf: "x.pdf", at: 5 }) } });
		const a = memoryAdapter({ [`${folder}/pdfcopy-0000000b.json`]: other });
		const store = new PdfCopyStore(a, () => "Notebooks", "0000000a");
		await store.load();
		expect(Object.keys(store.records())).toEqual(["x.notebook"]);
		await store.update((o) => ({ ...o, copies: { ...o.copies, "y.notebook": rec({ notebook: "y.notebook", pdf: "y.pdf", at: 6 }) } }));
		expect(Object.keys(store.records()).sort()).toEqual(["x.notebook", "y.notebook"]);
		expect(a.files[`${folder}/pdfcopy-0000000b.json`]).toBe(other);
		expect(Object.keys((JSON.parse(a.files[own]!) as { copies: object }).copies)).toEqual(["y.notebook"]);
		expect(store.allRecords()).toHaveLength(2);
	});

	it("never overwrites an unreadable, empty or newer own file", async () => {
		for (const [text, reason] of [["{broken", "json"], ["   ", "empty"], ['{"version":9,"copies":{}}', "future"]] as const) {
			const a = memoryAdapter({ [own]: text });
			const store = new PdfCopyStore(a, () => "Notebooks", "0000000a");
			await expect(store.update((o) => ({ ...o, copies: { n: rec() } }))).rejects.toMatchObject({ reason });
			await expect(store.update((o) => o)).rejects.toBeInstanceOf(PdfCopyBlockedError);
			expect(a.files[own]).toBe(text);
		}
		const a = memoryAdapter({ [own]: "{broken" });
		await new PdfCopyStore(a, () => "Notebooks", "0000000a").update((o) => o).catch(() => undefined);
		expect(Object.keys(a.files).some((f) => f.includes("pdfcopy.unreadable-"))).toBe(true);
	});

	it("does not rewrite an unchanged file", async () => {
		const a = memoryAdapter();
		const store = new PdfCopyStore(a, () => "Notebooks", "0000000a");
		await store.update((o) => ({ ...o, copies: { n: rec() } }));
		const first = a.files[own];
		let writes = 0;
		a.write = async (p, d) => (writes++, void (a.files[p] = d));
		await store.update((o) => ({ ...o, copies: { n: rec() } }));
		expect(writes).toBe(0);
		expect(a.files[own]).toBe(first);
	});
});
