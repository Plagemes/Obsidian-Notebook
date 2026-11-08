import { describe, expect, it } from "vitest";
import { PageRefIndex, pageLinksIn, refsSummary, targetsNotebook } from "../src/model/page-refs";
import type { Page, PageElement } from "../src/model/types";

const OWNER = "Notebooks/Physics.notebook";

function text(id: string, t: string): PageElement {
	return { id, type: "text", x: 0, y: 0, width: 200, text: t, fontSize: 16, color: "#000" } as PageElement;
}

function page(id: string, ...texts: string[]): Page {
	return {
		id, width: 600, height: 800, paper: { kind: "blank" }, strokes: [],
		elements: texts.map((t, i) => text(`${id}-t${i}`, t)),
	} as unknown as Page;
}

const link = (n: number, id: string) => `[[Physics.notebook#p${n}&id=${id}]]`;

function index(): PageRefIndex {
	const ix = new PageRefIndex();
	ix.setOwner(OWNER);
	return ix;
}

describe("targetsNotebook", () => {
	it("matches the path, the name and the name without extension", () => {
		expect(targetsNotebook("Notebooks/Physics.notebook", OWNER)).toBe(true);
		expect(targetsNotebook("Physics.notebook", OWNER)).toBe(true);
		expect(targetsNotebook("Physics", OWNER)).toBe(true);
		expect(targetsNotebook("physics", OWNER)).toBe(true);
	});
	it("rejects another notebook", () => {
		expect(targetsNotebook("Chemistry", OWNER)).toBe(false);
		expect(targetsNotebook("Other/Physics.notebook", OWNER)).toBe(false);
		expect(targetsNotebook("", OWNER)).toBe(false);
	});
});

describe("pageLinksIn", () => {
	it("reads ids and numbers, ignores headings, blocks and other notebooks", () => {
		const links = pageLinksIn(`${link(7, "pg7")} [[Physics#p3]] [[Physics#Intro]] [[Physics#^abc]] [[Chemistry#p2]] ![[Physics#p4]] [[Physics]]`, OWNER);
		expect(links.map((l) => [l.target.page, l.target.pageId])).toEqual([[7, "pg7"], [3, null]]);
	});
});

describe("PageRefIndex", () => {
	it("lists the pages that refer to a page, by id", () => {
		const pages = [page("a"), page("b", link(1, "a")), page("c"), page("d", `${link(1, "a")} and ${link(1, "a")}`, link(3, "c"))];
		const ix = index();
		expect(ix.referencedFrom(pages, "a")).toEqual([{ index: 1, pageId: "b", count: 1 }, { index: 3, pageId: "d", count: 2 }]);
		expect(ix.referencedFrom(pages, "c")).toEqual([{ index: 3, pageId: "d", count: 1 }]);
		expect(ix.referencedFrom(pages, "b")).toEqual([]);
	});

	it("keeps the references when pages are reordered", () => {
		const a = page("a");
		const b = page("b", link(1, "a"));
		const ix = index();
		expect(ix.referencedFrom([a, b], "a")).toEqual([{ index: 1, pageId: "b", count: 1 }]);
		expect(ix.referencedFrom([b, page("x"), a], "a")).toEqual([{ index: 0, pageId: "b", count: 1 }]);
	});

	it("resolves a link without an id by its number", () => {
		const pages = [page("a"), page("b"), page("c", "[[Physics#p2]]")];
		expect(index().referencedFrom(pages, "b")).toEqual([{ index: 2, pageId: "c", count: 1 }]);
		expect(index().referencedFrom(pages, "a")).toEqual([]);
	});

	it("matches nothing for a deleted page and never falls back to its number", () => {
		const pages = [page("a"), page("b", link(1, "gone"))];
		const ix = index();
		expect(ix.referencedFrom(pages, "a")).toEqual([]);
		expect(ix.referencedFrom(pages, "b")).toEqual([]);
		expect(ix.referencedCounts(pages).size).toBe(0);
	});

	it("ignores a page that refers to itself", () => {
		const pages = [page("a", link(1, "a")), page("b", link(1, "a"))];
		const ix = index();
		expect(ix.referencedFrom(pages, "a")).toEqual([{ index: 1, pageId: "b", count: 1 }]);
		expect(ix.referencedCounts(pages).get("a")).toBe(1);
	});

	it("handles many links and caps the list", () => {
		const pages = [page("t")];
		for (let i = 0; i < 400; i++) pages.push(page(`s${i}`, link(1, "t")));
		const ix = index();
		const refs = ix.referencedFrom(pages, "t");
		expect(refs.length).toBe(200);
		expect(refs[0]!.index).toBe(1);
		const many = page("m", Array.from({ length: 1000 }, () => link(1, "t")).join(" "));
		expect(index().referencedFrom([page("t"), many], "t")[0]!.count).toBe(300);
	});

	it("rescans only pages whose link texts changed", () => {
		const pages = [page("a", "no link here"), page("b", link(1, "a")), page("c", "plain")];
		const ix = index();
		ix.referencedFrom(pages, "a");
		ix.resetCount();
		// New element arrays with the same content: no rescan.
		const same = pages.map((p) => ({ ...p, elements: p.elements!.map((e) => ({ ...e })) }));
		ix.referencedFrom(same, "a");
		expect(ix.scanned).toBe(0);
		const edited = [same[0]!, { ...same[1]!, elements: [text("b-t0", link(1, "c"))] }, same[2]!];
		const before = ix.version;
		expect(ix.referencedFrom(edited, "a")).toEqual([]);
		expect(ix.scanned).toBe(1);
		expect(ix.version).toBeGreaterThan(before);
	});

	it("warms in slices and says how many are left", () => {
		const pages = Array.from({ length: 50 }, (_, i) => page(`p${i}`, i > 0 ? link(1, "p0") : ""));
		const ix = index();
		let clock = 0;
		const left = ix.warm(pages, 5, () => (clock += 2));
		expect(left).toBeGreaterThan(0);
		expect(ix.pending(pages)).toBe(left);
		while (ix.warm(pages, 5, () => (clock += 2)) > 0);
		expect(ix.pending(pages)).toBe(0);
		expect(ix.referencedFrom(pages, "p0").length).toBe(49);
	});

	it("matches against a new owner path after a rename", () => {
		const pages = [page("a"), page("b", "[[Physics#p1]]")];
		const ix = index();
		expect(ix.referencedFrom(pages, "a").length).toBe(1);
		ix.setOwner("Notebooks/Chemistry.notebook");
		expect(ix.referencedFrom(pages, "a").length).toBe(0);
	});

	it("reads sticky notes too", () => {
		const sticky = { id: "s", type: "sticky", x: 0, y: 0, width: 50, height: 50, color: "#ff0", fontSize: 14, text: link(1, "a") } as PageElement;
		const pages = [page("a"), { ...page("b"), elements: [sticky] }];
		expect(index().referencedFrom(pages, "a").length).toBe(1);
	});
});

describe("refsSummary", () => {
	it("lists the first pages and counts the rest", () => {
		const refs = [2, 5, 8, 11, 14].map((i) => ({ index: i, pageId: `p${i}`, count: 1 }));
		expect(refsSummary(refs)).toEqual({ shown: [3, 6, 9], more: 2 });
		expect(refsSummary(refs.slice(0, 2))).toEqual({ shown: [3, 6], more: 0 });
	});
});
