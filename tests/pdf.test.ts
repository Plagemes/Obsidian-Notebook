import { describe, expect, it } from "vitest";
import { assetExtension, assetFileName, assetPath, assetsFolder, kindFromName } from "../src/pdf/assets";
import { assetIdFromHash, sha256Hex } from "../src/pdf/hash";
import { helveticaWidth, toWinAnsi, winAnsiCode, wrapHelvetica } from "../src/pdf/helvetica";
import { isAbortError, MAX_BITMAP_SIDE, PdfStore, type CanvasLike } from "../src/pdf/pdf-store";
import type { PdfDoc, PdfLib, PdfPage, PdfRenderTask } from "../src/pdf/pdfjs-types";

const utf8 = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("hash", () => {
	it("matches the SHA-256 test vectors", async () => {
		expect(await sha256Hex(utf8(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(await sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("uses the first 24 hex chars as asset id", async () => {
		const id = assetIdFromHash(await sha256Hex(utf8("abc")));
		expect(id).toBe("ba7816bf8f01cfea41414" + "0de");
		expect(id).toHaveLength(24);
	});
});

describe("assets", () => {
	it("derives the kind from the file name", () => {
		expect(kindFromName("Book.PDF")).toBe("pdf");
		for (const n of ["a.png", "a.jpg", "a.JPEG", "a.webp", "a.gif"]) expect(kindFromName(n)).toBe("image");
		expect(kindFromName("a.txt")).toBeNull();
		expect(kindFromName("noext")).toBeNull();
		expect(kindFromName("dir.d/noext")).toBeNull();
	});

	it("names files <id>.<ext>, defaulting by kind", () => {
		expect(assetFileName("abc", "pdf", "x.pdf")).toBe("abc.pdf");
		expect(assetFileName("abc", "pdf", "weird")).toBe("abc.pdf");
		expect(assetFileName("abc", "image", "photo.JPG")).toBe("abc.jpg");
		expect(assetFileName("abc", "image", "photo.jpeg")).toBe("abc.jpeg");
		expect(assetFileName("abc", "image", "a.webp")).toBe("abc.webp");
		expect(assetFileName("abc", "image", "a.gif")).toBe("abc.gif");
		expect(assetFileName("abc", "image", "scan")).toBe("abc.png");
		expect(assetExtension("image", "a.bmp")).toBe("png");
	});

	it("builds folder and paths", () => {
		expect(assetsFolder("Notebooks")).toBe("Notebooks/_assets");
		expect(assetsFolder("/Notebooks/sub/")).toBe("Notebooks/sub/_assets");
		expect(assetsFolder("")).toBe("_assets");
		expect(assetPath("Notebooks/_assets", "abc", "pdf")).toBe("Notebooks/_assets/abc.pdf");
		expect(assetPath("Notebooks/_assets/", "abc", ".png")).toBe("Notebooks/_assets/abc.png");
	});
});

describe("helvetica", () => {
	it("measures with the AFM widths", () => {
		expect(helveticaWidth("Hello", 1000)).toBe(722 + 556 + 222 + 222 + 556);
		expect(helveticaWidth(" ", 10)).toBeCloseTo(2.78);
		expect(helveticaWidth("W", 10)).toBeCloseTo(9.44);
	});

	it("maps Unicode to WinAnsi and replaces the rest with ?", () => {
		expect(winAnsiCode(0xe9)).toBe(0xe9);
		expect(winAnsiCode(0x20ac)).toBe(0x80);
		expect(winAnsiCode(0x2019)).toBe(0x92);
		expect(winAnsiCode(0x65e5)).toBe(63);
		expect(winAnsiCode(9)).toBe(32);
		expect(toWinAnsi("a😀")).toEqual([97, 63]);
	});

	it("wraps greedily at the width, keeps newlines and splits long words", () => {
		const text = "the quick brown fox jumps over the lazy dog";
		const lines = wrapHelvetica(text, 12, 100);
		expect(lines.length).toBeGreaterThan(2);
		for (const l of lines) {
			expect(helveticaWidth(String.fromCharCode(...l), 12)).toBeLessThanOrEqual(100);
			expect(l[0]).not.toBe(32);
			expect(l[l.length - 1]).not.toBe(32);
		}
		expect(lines.map((l) => String.fromCharCode(...l)).join(" ")).toBe(text);

		expect(wrapHelvetica("a\n\nb", 12, 100).map((l) => l.length)).toEqual([1, 0, 1]);
		const long = wrapHelvetica("x".repeat(100), 12, 50);
		expect(long.length).toBeGreaterThan(1);
		expect(long.flat()).toHaveLength(100);
		expect(wrapHelvetica("abc", 12, 0.1).map((l) => l.length)).toEqual([1, 1, 1]);
		expect(wrapHelvetica("", 12, 100)).toEqual([[]]);
	});
});

// ---- PdfStore with fake pdf.js ------------------------------------------------------------

interface RenderCall {
	asset: string;
	page: number;
	scale: number;
	task: PdfRenderTask;
	finish(): void;
	cancelled: boolean;
}

function makeEnv(
	docs: Record<string, Array<[number, number]>>,
	opts: { manual?: boolean; budget?: number; maxDocs?: number } = {},
) {
	const log = { getDocument: 0, reads: 0, destroyed: [] as string[], renders: [] as RenderCall[], canvases: [] as Array<{ w: number; h: number }> };
	const lib: PdfLib = {
		getDocument({ data }) {
			log.getDocument++;
			const id = new TextDecoder().decode(data as Uint8Array);
			const pages = docs[id]!;
			const doc: PdfDoc = {
				numPages: pages.length,
				getPage: async (n) => {
					const [w, h] = pages[n - 1]!;
					const page: PdfPage = {
						getViewport: ({ scale }) => ({ width: w * scale, height: h * scale }),
						render: ({ viewport }) => {
							let resolve!: () => void;
							let reject!: (e: unknown) => void;
							const promise = new Promise<void>((res, rej) => {
								resolve = res;
								reject = rej;
							});
							const call: RenderCall = {
								asset: id,
								page: n,
								scale: viewport.width / w,
								cancelled: false,
								finish: () => resolve(),
								task: {
									promise,
									cancel: () => {
										call.cancelled = true;
										reject(new Error("RenderingCancelledException"));
									},
								},
							};
							log.renders.push(call);
							if (!opts.manual) resolve();
							return call.task;
						},
					};
					return page;
				},
				destroy: async () => {
					log.destroyed.push(id);
				},
			};
			return { promise: Promise.resolve(doc) };
		},
	};
	const store = new PdfStore({
		loadPdfJs: async () => lib,
		readAsset: async (id) => {
			log.reads++;
			return utf8(id);
		},
		createCanvas: (w, h) => {
			log.canvases.push({ w, h });
			return { width: w, height: h, getContext: () => ({}) } as unknown as HTMLCanvasElement;
		},
		memoryBudgetBytes: opts.budget,
		maxOpenDocs: opts.maxDocs,
	});
	return { store, log };
}

describe("PdfStore", () => {
	it("caches page count and sizes (one open document)", async () => {
		const { store, log } = makeEnv({ a: [[600, 800], [400, 500]] });
		expect(await store.pageCount("a")).toBe(2);
		expect(await store.pageSizes("a")).toEqual([{ width: 600, height: 800 }, { width: 400, height: 500 }]);
		await store.pageSizes("a");
		await store.pageCount("a");
		expect(log.getDocument).toBe(1);
		expect(log.reads).toBe(1);
	});

	it("renders at the scale, caches the bitmap and reuses it", async () => {
		const { store, log } = makeEnv({ a: [[100, 200]] });
		const c1 = await store.render("a", 1, 2);
		expect(c1.width).toBe(200);
		expect(c1.height).toBe(400);
		const c2 = await store.render("a", 1, 2);
		expect(c2).toBe(c1);
		expect(log.renders).toHaveLength(1);
		expect(store.cachedBytes).toBe(200 * 400 * 4);
		await store.render("a", 1, 3);
		expect(log.renders).toHaveLength(2);
	});

	it("rejects pages out of range", async () => {
		const { store } = makeEnv({ a: [[100, 100]] });
		await expect(store.render("a", 2, 1)).rejects.toBeInstanceOf(RangeError);
		await expect(store.render("a", 0, 1)).rejects.toBeInstanceOf(RangeError);
	});

	it("clamps the scale so no bitmap side exceeds 4096 px", async () => {
		const { store } = makeEnv({ a: [[600, 800]] });
		const c = await store.render("a", 1, 10);
		expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(MAX_BITMAP_SIDE);
		expect(c.height).toBeGreaterThan(4000);
		// A request above the cap and the cap itself share one cache entry.
		expect(await store.render("a", 1, 50)).toBe(c);
	});

	it("evicts least recently used bitmaps beyond the memory budget", async () => {
		const { store } = makeEnv({ a: [[100, 100], [100, 100], [100, 100]] }, { budget: 100_000 });
		await store.render("a", 1, 1); // 40 000 bytes each
		await store.render("a", 2, 1);
		await store.render("a", 1, 1); // touch page 1
		expect(store.cachedBytes).toBe(80_000);
		await store.render("a", 3, 1); // 120 000 > budget: page 2 goes
		expect(store.peek("a", 2)).toBeNull();
		expect(store.peek("a", 1)).not.toBeNull();
		expect(store.peek("a", 3)).not.toBeNull();
		expect(store.cachedBytes).toBe(80_000);
	});

	it("always keeps the newest bitmap even if it alone exceeds the budget", async () => {
		const { store } = makeEnv({ a: [[100, 100], [100, 100]] }, { budget: 10 });
		await store.render("a", 1, 1);
		expect(store.peek("a", 1)).not.toBeNull();
		await store.render("a", 2, 1);
		expect(store.peek("a", 1)).toBeNull();
		expect(store.peek("a", 2)).not.toBeNull();
	});

	it("dedupes concurrent identical renders", async () => {
		const { store, log } = makeEnv({ a: [[100, 100]] }, { manual: true });
		const p1 = store.render("a", 1, 1);
		const p2 = store.render("a", 1, 1);
		await flush();
		expect(log.renders).toHaveLength(1);
		log.renders[0]!.finish();
		const [c1, c2] = await Promise.all([p1, p2]);
		expect(c1).toBe(c2);
		expect(log.canvases).toHaveLength(1);
	});

	it("cancels a pending render of the same page at another scale", async () => {
		const { store, log } = makeEnv({ a: [[100, 100], [100, 100]] }, { manual: true });
		const old = store.render("a", 1, 1);
		const oldResult = old.then(
			() => "ok",
			(e: unknown) => (isAbortError(e) ? "aborted" : "error"),
		);
		await flush();
		const other = store.render("a", 2, 1); // a different page is not affected
		const fresh = store.render("a", 1, 2);
		await flush();
		expect(log.renders.filter((r) => r.cancelled)).toHaveLength(1);
		expect(log.renders[0]!.cancelled).toBe(true);
		expect(await oldResult).toBe("aborted");
		for (const r of log.renders) if (!r.cancelled) r.finish();
		expect((await fresh).width).toBe(200);
		expect((await other).width).toBe(100);
		expect(store.peek("a", 1)!.scale).toBe(2);
	});

	it("rejects with an abort error when cancelled before pdf.js started", async () => {
		const { store } = makeEnv({ a: [[100, 100]] });
		await store.pageSizes("a");
		const first = store.render("a", 1, 1);
		const firstResult = first.then(
			() => "ok",
			(e: unknown) => (isAbortError(e) ? "aborted" : "error"),
		);
		const second = store.render("a", 1, 2);
		await expect(second).resolves.toBeDefined();
		expect(await firstResult).toBe("aborted");
	});

	it("peek returns the best cached bitmap synchronously", async () => {
		const { store } = makeEnv({ a: [[100, 100]] });
		expect(store.peek("a", 1)).toBeNull();
		await store.render("a", 1, 1);
		await store.render("a", 1, 2);
		await store.render("a", 1, 4);
		expect(store.peek("a", 1, 1.5)!.scale).toBe(2); // smallest >= minScale
		expect(store.peek("a", 1, 0.5)!.scale).toBe(1);
		expect(store.peek("a", 1, 8)!.scale).toBe(4); // nothing sharp enough: closest below
		expect(store.peek("a", 1)!.scale).toBe(4); // no minimum: best available
		expect(store.peek("a", 2)).toBeNull();
		expect(store.peek("b", 1)).toBeNull();
		const hit = store.peek("a", 1, 2)!;
		expect(hit.canvas.width).toBe(200);
	});

	it("keeps at most maxOpenDocs documents open and destroys the least recently used", async () => {
		const { store, log } = makeEnv({ a: [[10, 10], [10, 10]], b: [[10, 10]], c: [[10, 10]] }, { maxDocs: 2 });
		await store.render("a", 1, 1);
		await store.render("b", 1, 1);
		await store.render("a", 2, 1); // a is more recent than b
		await store.render("c", 1, 1);
		await flush();
		expect(log.destroyed).toEqual(["b"]);
		expect(log.getDocument).toBe(3);
		await store.render("b", 1, 2); // reopened (sizes stay cached)
		await flush();
		expect(log.getDocument).toBe(4);
		expect(log.destroyed).toEqual(["b", "a"]);
	});

	it("evictAsset drops bitmaps, sizes and the document", async () => {
		const { store, log } = makeEnv({ a: [[100, 100]], b: [[100, 100]] });
		await store.render("a", 1, 1);
		await store.render("b", 1, 1);
		store.evictAsset("a");
		await flush();
		expect(log.destroyed).toEqual(["a"]);
		expect(store.peek("a", 1)).toBeNull();
		expect(store.peek("b", 1)).not.toBeNull();
		expect(store.cachedBytes).toBe(40_000);
		await store.render("a", 1, 1);
		expect(log.getDocument).toBe(3);
	});

	it("clear empties everything and destroys all documents", async () => {
		const { store, log } = makeEnv({ a: [[100, 100]], b: [[100, 100]] });
		await store.render("a", 1, 1);
		await store.render("b", 1, 1);
		store.clear();
		await flush();
		expect(store.cachedBytes).toBe(0);
		expect(store.peek("a", 1)).toBeNull();
		expect(log.destroyed.sort()).toEqual(["a", "b"]);
	});

	it("does not cache a failed document load", async () => {
		let fail = true;
		const lib: PdfLib = {
			getDocument: () => ({
				promise: fail
					? Promise.reject(new Error("bad pdf"))
					: Promise.resolve({ numPages: 1, getPage: async () => ({ getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve(), cancel() {} }) }), destroy: async () => {} }),
			}),
		};
		const store = new PdfStore({
			loadPdfJs: async () => lib,
			readAsset: async () => new ArrayBuffer(1),
			createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ({}) }) as unknown as CanvasLike,
		});
		await expect(store.pageCount("x")).rejects.toThrow("bad pdf");
		fail = false;
		expect(await store.pageCount("x")).toBe(1);
	});
});
