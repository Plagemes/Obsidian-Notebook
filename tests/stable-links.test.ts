/** Stable page links (wave 0.8, 388): links the plugin writes name the page by id; old `#pN` links can be pinned. */
import { describe, expect, it } from "vitest";
import { checkPageRef } from "../src/integration/api-plan";
import {
	applyLinkChanges, planNoteLinks, rewriteFragment, scanPageLinks, type NotebookLookup,
} from "../src/integration/link-update";
import { notebookUri, pageIdFromState, parseEmbedSource, parseProtocolParams } from "../src/integration/links";
import {
	pageSuggestions, pageTargetFromEphemeralState, pageTargetFromSubpath, resolvePageTarget, stablePageSubpath,
} from "../src/integration/page-links";
import { createPage } from "../src/model/document";

const ID = "3f2a9c1e-7b4d-4e0a-9d55-0c1b2a3d4e5f";

describe("links the plugin writes", () => {
	it("name the page by id and keep p<n> for readers that only know numbers", () => {
		expect(stablePageSubpath(3, ID)).toBe(`#p3&id=${ID}`);
		expect(stablePageSubpath(3, undefined)).toBe("#p3");
		expect(stablePageSubpath(3, "bad id!")).toBe("#p3");
		expect(pageTargetFromSubpath(stablePageSubpath(3, ID))).toEqual({ page: 3, pageId: ID });
	});

	it("page suggestions carry the id", () => {
		const pages = [createPage(), createPage()];
		expect(pageSuggestions(pages, "").map((s) => s.pageId)).toEqual(pages.map((p) => p.id));
	});

	it("obsidian:// links carry the id, and the protocol handler reads it", () => {
		const uri = notebookUri("", "Notebooks/Physics.notebook", 3, ID);
		expect(uri).toBe(`obsidian://notebook?path=Notebooks%2FPhysics.notebook&page=3&id=${ID}`);
		const query = Object.fromEntries(new URL(uri).searchParams);
		expect(parseProtocolParams(query)).toEqual({ ok: true, path: "Notebooks/Physics.notebook", page: 3, pageId: ID });
		// Old links and bad ids still work (the number decides).
		expect(notebookUri("", "a.notebook", 2)).toBe("obsidian://notebook?path=a.notebook&page=2");
		expect(notebookUri("", "a.notebook", 2, "no good")).toBe("obsidian://notebook?path=a.notebook&page=2");
		expect(parseProtocolParams({ path: "a.notebook", page: "2", id: "no good" })).toEqual({ ok: true, path: "a.notebook", page: 2, pageId: null });
	});
});

describe("opening by id", () => {
	const pages = [{ id: "a" }, { id: "b" }, { id: "c" }];

	it("a view state or ephemeral state with a page id names the page, with or without a number", () => {
		expect(pageIdFromState({ pageId: ID })).toBe(ID);
		expect(pageIdFromState({ pageId: "no good" })).toBeNull();
		expect(pageTargetFromEphemeralState({ page: 2, pageId: ID })).toEqual({ page: 2, pageId: ID });
		expect(pageTargetFromEphemeralState({ pageId: ID })).toEqual({ page: null, pageId: ID });
		expect(pageTargetFromEphemeralState({ page: 4 })).toEqual({ page: 4, pageId: null });
		expect(pageTargetFromEphemeralState({ subpath: `#p3&id=${ID}` })).toEqual({ page: 3, pageId: ID });
		expect(pageTargetFromEphemeralState({})).toBeNull();
	});

	it("resolves by id first: a moved page is found, a deleted one is reported, never replaced by the page now at that number", () => {
		expect(resolvePageTarget(pages, { page: 1, pageId: "c" })).toEqual({ index: 2 });
		expect(resolvePageTarget(pages, { page: 1, pageId: "gone" })).toEqual({ missing: "deleted" });
		expect(resolvePageTarget(pages, { page: 2, pageId: null })).toEqual({ index: 1 });
	});

	it("embeds with an id parse the same way (the id wins over the number at render time)", () => {
		const parsed = parseEmbedSource(`path: Notebooks/Physics.notebook#p3&id=${ID}`);
		expect(parsed).toMatchObject({ ok: true, page: 3, pageId: ID });
	});
});

describe("API page references", () => {
	const pages = [{ id: "a" }, { id: "b" }, { id: "c" }];
	it("accepts a number or an id and refuses an unknown id", () => {
		expect(checkPageRef("page", 2, pages)).toBe(2);
		expect(checkPageRef("page", "c", pages)).toBe(3);
		expect(() => checkPageRef("page", "zz", pages)).toThrow(/no page has this id/);
		expect(() => checkPageRef("page", 4, pages)).toThrow(/page number from 1 to 3/);
		expect(() => checkPageRef("page", undefined, pages)).toThrow();
	});
});

// ---------------------------------------------------------------------- update links

/** Notebooks by path: their page ids in order. */
function lookupOf(books: Record<string, string[]>, opts: { ambiguous?: string[]; unreadable?: string[] } = {}): NotebookLookup {
	const nameToPath = new Map(Object.keys(books).map((p) => [p.split("/").pop()!.toLowerCase(), p] as const));
	return {
		resolve(linkPath) {
			const name = (linkPath.split("/").pop() ?? "").toLowerCase();
			const path = nameToPath.get(name);
			return path ? { path, ambiguous: opts.ambiguous?.includes(path) ?? false } : null;
		},
		pageIds: (path) => Promise.resolve(opts.unreadable?.includes(path) ? null : books[path] ?? null),
		notebooksWithPage: (id) => Promise.resolve(Object.entries(books).filter(([, ids]) => ids.includes(id)).map(([p]) => p)),
		linkPathFor: (path) => path.split("/").pop()!,
	};
}

describe("finding page links in a note", () => {
	it("finds wikilinks, embeds and Markdown links with a page subpath, with exact offsets", () => {
		const text = "See [[Physics.notebook#p3|the page]] and ![[Physics.notebook#p4&id=x1]] or [here](Notebooks/Physics.notebook#p5).";
		const links = scanPageLinks(text);
		expect(links.map((l) => [l.kind, l.embed, l.path, l.fragment])).toEqual([
			["wiki", false, "Physics.notebook", "p3"],
			["wiki", true, "Physics.notebook", "p4&id=x1"],
			["md", false, "Notebooks/Physics.notebook", "p5"],
		]);
		for (const l of links) {
			expect(text.slice(l.fragStart, l.fragEnd)).toBe(l.fragment);
			expect(text.slice(l.pathStart, l.pathEnd)).toBe(l.kind === "md" ? "Notebooks/Physics.notebook" : l.path);
		}
	});

	it("ignores headings, block ids, code and links without a subpath", () => {
		const text = "[[Note#Heading]] [[Note#^block]] [[Physics.notebook]]\n```\n[[Physics.notebook#p3]]\n```\n`[[Physics.notebook#p3]]` [[Physics.notebook#p3&r=bad]]";
		expect(scanPageLinks(text)).toEqual([]);
	});

	it("keeps offsets right for a Markdown link whose label repeats the path", () => {
		const text = "[Physics.notebook](Physics.notebook#p2)";
		const [link] = scanPageLinks(text);
		expect(text.slice(link!.pathStart, link!.pathEnd)).toBe("Physics.notebook");
		expect(link!.pathStart).toBe(text.indexOf("(") + 1);
	});

	it("rewrites the fragment, keeping a region", () => {
		expect(rewriteFragment("p3", 3, "x")).toBe("p3&id=x");
		expect(rewriteFragment("p3&id=old&r=1,2,3,4", 5, "x")).toBe("p5&id=x&r=1,2,3,4");
	});
});

describe("planning the update", () => {
	const note = "n/Note.md";

	it("pins an old #pN link to the page that has that number, and says what it is", async () => {
		const text = "[[Physics.notebook#p2|b]]";
		const plan = await planNoteLinks(note, text, lookupOf({ "N/Physics.notebook": ["a", "b", "c"] }));
		expect(plan.skipped).toEqual([]);
		expect(plan.changes).toHaveLength(1);
		expect(plan.changes[0]).toMatchObject({ kind: "pin", notebook: "N/Physics.notebook", before: "p2", after: "p2&id=b", page: 2 });
		expect(applyLinkChanges(text, plan.changes).text).toBe("[[Physics.notebook#p2&id=b|b]]");
	});

	it("renumbers an id link whose page moved, leaves a correct one alone", async () => {
		const books = { "N/Physics.notebook": ["a", "b", "c"] };
		const text = "[[Physics.notebook#p1&id=c]] [[Physics.notebook#p2&id=b]]";
		const plan = await planNoteLinks(note, text, lookupOf(books));
		expect(plan.changes.map((c) => [c.kind, c.after])).toEqual([["renumber", "p3&id=c"]]);
		expect(applyLinkChanges(text, plan.changes).text).toBe("[[Physics.notebook#p3&id=c]] [[Physics.notebook#p2&id=b]]");
	});

	it("follows a page to the one other notebook that has it; refuses when there are none or several", async () => {
		const books = { "N/Old.notebook": ["a"], "N/New.notebook": ["z", "b"] };
		const text = "[[Old.notebook#p2&id=b|x]]";
		const plan = await planNoteLinks(note, text, lookupOf(books));
		expect(plan.changes[0]).toMatchObject({ kind: "relocate", notebook: "N/New.notebook", page: 2 });
		expect(applyLinkChanges(text, plan.changes).text).toBe("[[New.notebook#p2&id=b|x]]");

		const gone = await planNoteLinks(note, "[[Old.notebook#p2&id=q]]", lookupOf(books));
		expect(gone.changes).toEqual([]);
		expect(gone.skipped.map((s) => s.reason)).toEqual(["page-gone"]);

		const twice = await planNoteLinks(note, "[[Old.notebook#p2&id=b]]", lookupOf({ ...books, "N/Copy.notebook": ["b"] }));
		expect(twice.changes).toEqual([]);
		expect(twice.skipped.map((s) => s.reason)).toEqual(["id-in-several"]);
	});

	it("never guesses: ambiguous notebook, page number out of range, unreadable notebook", async () => {
		const books = { "N/Physics.notebook": ["a", "b"] };
		const amb = await planNoteLinks(note, "[[Physics.notebook#p1]]", lookupOf(books, { ambiguous: ["N/Physics.notebook"] }));
		expect(amb.skipped.map((s) => s.reason)).toEqual(["ambiguous-notebook"]);
		const range = await planNoteLinks(note, "[[Physics.notebook#p9]]", lookupOf(books));
		expect(range.skipped.map((s) => s.reason)).toEqual(["page-out-of-range"]);
		const broken = await planNoteLinks(note, "[[Physics.notebook#p1]] [[Physics.notebook#p1&id=a]]", lookupOf(books, { unreadable: ["N/Physics.notebook"] }));
		expect(broken.changes).toEqual([]);
		expect(broken.skipped.map((s) => s.reason)).toEqual(["unreadable", "unreadable"]);
		// A link to something that is not a notebook is not ours.
		const other = await planNoteLinks(note, "[[Other#p1]]", lookupOf(books));
		expect(other).toEqual({ changes: [], skipped: [] });
	});

	it("applies from the end, and leaves a link alone when the note changed since the plan", async () => {
		const text = "[[Physics.notebook#p1]] and [[Physics.notebook#p3]]";
		const plan = await planNoteLinks(note, text, lookupOf({ "N/Physics.notebook": ["a", "b", "c"] }));
		expect(plan.changes).toHaveLength(2);
		const all = applyLinkChanges(text, plan.changes);
		expect(all).toEqual({ text: "[[Physics.notebook#p1&id=a]] and [[Physics.notebook#p3&id=c]]", applied: 2, stale: 0 });
		const edited = text.replace("p3", "p4");
		expect(applyLinkChanges(edited, plan.changes)).toEqual({ text: "[[Physics.notebook#p1&id=a]] and [[Physics.notebook#p4]]", applied: 1, stale: 1 });
	});

	it("rewrites a Markdown link target with a percent-encoded path", async () => {
		const books = { "N/My Old.notebook": ["a"], "N/My New.notebook": ["b"] };
		const lookup = { ...lookupOf(books), linkPathFor: (p: string) => p.split("/").pop()! };
		const text = "[x](My%20Old.notebook#p1&id=b)";
		const plan = await planNoteLinks(note, text, { ...lookup, resolve: (lp: string) => (decodeURIComponent(lp) === "My Old.notebook" ? { path: "N/My Old.notebook", ambiguous: false } : null) });
		expect(applyLinkChanges(text, plan.changes).text).toBe("[x](My%20New.notebook#p1&id=b)");
	});
});
