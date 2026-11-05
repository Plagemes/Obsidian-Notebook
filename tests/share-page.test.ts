import { describe, expect, it } from "vitest";
import {
	canShareFiles, classifyShareError, decideShare, DEFAULT_SHARE_CHOICE, formatShareSize, loadShareChoice, MAX_SHARE_PNG_PAGES, normaliseShareChoice,
	planShare, safeShareStem, saveShareChoice, SHARE_CHOICE_KEY, shareFileNames, shareMime, sizeVerdict, SHARE_WARN_BYTES, usableScope,
	type ShareChoice, type ShareStore,
} from "../src/model/share-page";

const choice = (patch: Partial<ShareChoice> = {}): ShareChoice => ({ ...DEFAULT_SHARE_CHOICE, ...patch });
const file = (name: string, type: string): File => new File(["x"], name, { type });

describe("normaliseShareChoice", () => {
	it("keeps a valid choice and replaces anything else by the default", () => {
		expect(normaliseShareChoice({ format: "pdf", scope: "range", clean: true })).toEqual({ format: "pdf", scope: "range", clean: true });
		expect(normaliseShareChoice({ format: "gif", scope: 3, clean: "yes", extra: 1 })).toEqual(DEFAULT_SHARE_CHOICE);
		for (const bad of [null, undefined, 4, "pdf", [], true]) expect(normaliseShareChoice(bad)).toEqual(DEFAULT_SHARE_CHOICE);
	});
});

describe("share choice in local storage", () => {
	const fake = (initial?: unknown, throws = false): ShareStore & { data: Map<string, unknown> } => {
		const data = new Map<string, unknown>(initial === undefined ? [] : [[SHARE_CHOICE_KEY, initial]]);
		return {
			data,
			loadLocalStorage: (k) => {
				if (throws) throw new Error("blocked");
				return data.get(k) ?? null;
			},
			saveLocalStorage: (k, v) => {
				if (throws) throw new Error("blocked");
				data.set(k, v);
			},
		};
	};

	it("round-trips the choice", () => {
		const s = fake();
		saveShareChoice(s, choice({ format: "pdf", clean: true }));
		expect(loadShareChoice(s)).toEqual({ format: "pdf", scope: "page", clean: true });
	});

	it("reads a corrupt value as the default and never throws when storage is blocked", () => {
		expect(loadShareChoice(fake("garbage"))).toEqual(DEFAULT_SHARE_CHOICE);
		const blocked = fake(undefined, true);
		expect(loadShareChoice(blocked)).toEqual(DEFAULT_SHARE_CHOICE);
		expect(() => saveShareChoice(blocked, choice())).not.toThrow();
	});

	it("stores only the three known fields", () => {
		const s = fake();
		saveShareChoice(s, { ...choice(), junk: "x".repeat(10000) } as ShareChoice);
		expect(Object.keys(s.data.get(SHARE_CHOICE_KEY) as object).sort()).toEqual(["clean", "format", "scope"]);
	});
});

describe("usableScope", () => {
	it("falls back to the page when the selection or the range is not available", () => {
		expect(usableScope("selection", false, 5)).toBe("page");
		expect(usableScope("selection", true, 5)).toBe("selection");
		expect(usableScope("range", false, 1)).toBe("page");
		expect(usableScope("range", false, 4)).toBe("range");
	});
});

describe("planShare", () => {
	const base = { pageCount: 12, pageIndex: 3, hasSelection: false };

	it("shares the page in view in the format asked for", () => {
		expect(planShare({ ...base, choice: choice({ format: "pdf" }) })).toEqual({ ok: true, format: "pdf", scope: "page", pages: [3] });
		expect(planShare({ ...base, choice: choice() })).toEqual({ ok: true, format: "png", scope: "page", pages: [3] });
	});

	it("a selection is always one PNG, whatever the format says", () => {
		expect(planShare({ ...base, hasSelection: true, choice: choice({ format: "pdf", scope: "selection" }) })).toEqual({ ok: true, format: "png", scope: "selection", pages: [3] });
	});

	it("refuses a selection that is not there", () => {
		expect(planShare({ ...base, choice: choice({ scope: "selection" }) })).toEqual({ ok: false, problem: "no-selection" });
	});

	it("sorts, de-duplicates and bounds a range", () => {
		const p = planShare({ ...base, choice: choice({ format: "pdf", scope: "range" }), range: [5, 2, 2, 99, -1, 3] });
		expect(p).toEqual({ ok: true, format: "pdf", scope: "range", pages: [2, 3, 5] });
		expect(planShare({ ...base, choice: choice({ scope: "range" }), range: [] })).toEqual({ ok: false, problem: "no-pages" });
	});

	it("refuses a PNG range longer than the cap but allows the same pages as a PDF", () => {
		const range = Array.from({ length: MAX_SHARE_PNG_PAGES + 1 }, (_, i) => i);
		expect(planShare({ ...base, choice: choice({ scope: "range" }), range })).toEqual({ ok: false, problem: "too-many-png" });
		expect(planShare({ ...base, choice: choice({ format: "pdf", scope: "range" }), range }).ok).toBe(true);
		expect(planShare({ ...base, choice: choice({ scope: "range" }), range: range.slice(0, MAX_SHARE_PNG_PAGES) }).ok).toBe(true);
	});

	it("has no pages for a page out of the notebook", () => {
		expect(planShare({ ...base, pageIndex: 40, choice: choice() })).toEqual({ ok: false, problem: "no-pages" });
	});
});

describe("file names", () => {
	it("names a page, a PNG range, a PDF range and a selection", () => {
		expect(shareFileNames("Maths", "png", "page", [2])).toEqual(["Maths p3.png"]);
		expect(shareFileNames("Maths", "pdf", "page", [2])).toEqual(["Maths p3.pdf"]);
		expect(shareFileNames("Maths", "png", "range", [1, 2])).toEqual(["Maths p2.png", "Maths p3.png"]);
		expect(shareFileNames("Maths", "pdf", "range", [1, 2, 3, 4, 7])).toEqual(["Maths p2-5+8.pdf"]);
		expect(shareFileNames("Maths", "png", "selection", [0])).toEqual(["Maths p1 selection.png"]);
		expect(shareFileNames("Maths", "pdf", "selection", [0])).toEqual(["Maths p1 selection.png"]);
	});

	it("never puts a path or a reserved character in a name", () => {
		expect(safeShareStem("a/b\\c:d*e?f\"g<h>i|j")).not.toMatch(/[\\/:*?"<>|]/);
		expect(safeShareStem("   ")).toBe("Notebook");
		expect(safeShareStem("..hidden")).toBe("hidden");
		expect(safeShareStem("x".repeat(300)).length).toBe(80);
		expect(shareFileNames("../../etc", "png", "page", [0])[0]).not.toContain("/");
	});

	it("gives the type the share sheet needs", () => {
		expect(shareMime("png")).toBe("image/png");
		expect(shareMime("pdf")).toBe("application/pdf");
	});
});

describe("canShare branch", () => {
	const files = [file("a.png", "image/png")];

	it("shares when the device takes the files", () => {
		const nav = { canShare: () => true, share: () => Promise.resolve() };
		expect(canShareFiles(nav, files)).toBe(true);
		expect(decideShare(canShareFiles(nav, files))).toBe("share");
	});

	it("saves a copy when sharing files is not available", () => {
		expect(decideShare(canShareFiles(undefined, files))).toBe("save");
		expect(canShareFiles({}, files)).toBe(false);
		expect(canShareFiles({ share: () => Promise.resolve() }, files)).toBe(false);
		expect(canShareFiles({ canShare: () => false, share: () => Promise.resolve() }, files)).toBe(false);
		expect(canShareFiles({ canShare: () => true, share: () => Promise.resolve() }, [])).toBe(false);
	});

	it("treats a canShare that throws as not available", () => {
		const nav = { canShare: () => { throw new Error("nope"); }, share: () => Promise.resolve() };
		expect(canShareFiles(nav, files)).toBe(false);
	});
});

describe("size", () => {
	it("warns only above 25 MB", () => {
		expect(sizeVerdict(SHARE_WARN_BYTES)).toBe("ok");
		expect(sizeVerdict(SHARE_WARN_BYTES + 1)).toBe("warn");
		expect(sizeVerdict(0)).toBe("ok");
	});

	it("writes a size for a sentence", () => {
		expect(formatShareSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
		expect(formatShareSize(820 * 1024)).toBe("820 KB");
		expect(formatShareSize(10)).toBe("1 KB");
	});
});

describe("classifyShareError", () => {
	const err = (name: string): Error => Object.assign(new Error("x"), { name });
	it("reads a closed share sheet as a cancel, not an error", () => {
		expect(classifyShareError(err("AbortError"))).toBe("cancelled");
		expect(classifyShareError(new DOMException("closed", "AbortError"))).toBe("cancelled");
	});
	it("asks for a new tap when the browser wants one, falls back to saving when files are not accepted", () => {
		expect(classifyShareError(err("NotAllowedError"))).toBe("needs-tap");
		expect(classifyShareError(err("TypeError"))).toBe("unsupported");
		expect(classifyShareError(err("NotSupportedError"))).toBe("unsupported");
		expect(classifyShareError(err("DataError"))).toBe("failed");
		expect(classifyShareError("boom")).toBe("failed");
		expect(classifyShareError(null)).toBe("failed");
	});
});
