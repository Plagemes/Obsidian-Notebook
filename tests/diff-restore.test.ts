import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { planDiffRestore } from "../src/model/diff-restore";
import { History } from "../src/model/history";
import { diffDocuments } from "../src/model/version-diff";
import type { NotebookDocument, Page } from "../src/model/types";

function page(id: string, ids: string[] = []): Page {
	const p = createPage();
	p.id = id;
	p.strokes = ids.map((s) => ({ ...createStroke("#000000", 2, [[1, 1, 0.5], [9, 9, 0.5]]), id: s }));
	return p;
}
const doc = (pages: Page[]): NotebookDocument => ({ ...createDocument(), pages });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("planDiffRestore", () => {
	it("replaces a page that is still in the notebook, keeping its id, as one undo step", () => {
		const old = doc([page("a", ["s1", "s2"]), page("b")]);
		const now = doc([page("a", ["s1", "s3"]), page("b")]);
		const diff = diffDocuments(old, now);
		const r = planDiffRestore(now, old, "a", diff.pages, 0);
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.mode).toBe("replace");
		expect(r.target).toBe(0);
		const before = clone(now);
		const history = new History(() => now);
		history.execute(r.plan.command);
		expect(now.pages.map((p) => p.id)).toEqual(["a", "b"]);
		expect(now.pages[0]!.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
		history.undo();
		expect(JSON.parse(JSON.stringify(now))).toEqual(before);
	});

	it("puts a page that was removed back after the page that preceded it", () => {
		const old = doc([page("a"), page("b", ["x"]), page("c")]);
		const now = doc([page("a"), page("c")]);
		const diff = diffDocuments(old, now);
		const r = planDiffRestore(now, old, "b", diff.pages, 1);
		expect(r).toMatchObject({ kind: "ok", mode: "insert", target: 0 });
		if (r.kind !== "ok") return;
		new History(() => now).execute(r.plan.command);
		expect(now.pages).toHaveLength(3);
		expect(now.pages[1]!.strokes).toHaveLength(1);
		expect(now.pages[1]!.id).not.toBe("b");
	});

	it("a removed first page goes after the fallback page", () => {
		const old = doc([page("x"), page("a")]);
		const now = doc([page("a"), page("z")]);
		const diff = diffDocuments(old, now);
		const r = planDiffRestore(now, old, "x", diff.pages, 1);
		expect(r).toMatchObject({ kind: "ok", mode: "insert", target: 1 });
	});

	it("refuses a locked page and a page the version does not have", () => {
		const old = doc([page("a", ["s1"])]);
		const now = doc([page("a", ["s2"])]);
		now.pages[0]!.locked = true;
		const diff = diffDocuments(old, now);
		expect(planDiffRestore(now, old, "a", diff.pages, 0)).toEqual({ kind: "locked", n: 1 });
		expect(planDiffRestore(now, old, "nope", diff.pages, 0)).toEqual({ kind: "not-in-version" });
	});

	it("does nothing for an empty notebook", () => {
		const old = doc([page("a")]);
		const now = doc([]);
		expect(planDiffRestore(now, old, "a", diffDocuments(old, now).pages, 0)).toEqual({ kind: "nothing" });
	});
});
