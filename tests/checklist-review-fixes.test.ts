/**
 * Review fixes of the handwritten checklists (format v17, wave 0.19): the label cut that blocked saves (L1), the pending ticks and
 * the task line bookkeeping (L2, L3, L12), duplicates and moves (L4, L5), the merge of links and ties (L6, L10), the pen target
 * (L8), the task line search (L9), the honest text (L13), the path limit (L15) and the notebook map key (L16).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkboxAt, checkboxAtPen, PEN_TAP_MARGIN } from "../src/ink/checklist";
import { patchNotebookId } from "../src/library/host-logic";
import { planPageMove } from "../src/library/page-move";
import {
	CHECKBOX_LABEL_MAX, CHECKBOX_PATH_MAX, checkboxesOf, cleanCheckboxLabel, copiedCheckbox, isLinkablePath, renamedPath, setTaskLineChecked,
	unlinkChecklist, withCheckboxLabel, withCheckboxTask,
} from "../src/model/checklist";
import { setCheckboxLabel, setCheckboxTask } from "../src/model/checklist-commands";
import {
	ChecklistSync, GONE_CONFIRM_MS, RETRY_DELAYS, type SyncDeps, type SyncEntry, type SyncNotice, type SyncResult, type SyncSnapshot,
} from "../src/model/checklist-sync";
import { createDocument, createPage } from "../src/model/document";
import { History } from "../src/model/history";
import { mergeCovers, mergedCheckbox, planMerge } from "../src/model/merge";
import { mapKey } from "../src/model/notebook-map";
import { planTransfer } from "../src/model/notebook-transfer";
import { duplicatePage } from "../src/model/pages";
import { addEntry, emptyPageTrash, makeEntry, planPageTrashRestore } from "../src/model/page-trash";
import { freezeElement, parse, serialize, serializeChecked } from "../src/model/serialize";
import type { CheckboxElement, NotebookDocument } from "../src/model/types";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { setAt, type Raw } from "./raw-json";

const T0 = 1_760_000_000_000;
const stamp = "2026-11-05T10:00:00.000Z";
const TASK = { path: "Daily/2026-11-05.md", block: "nb-abc123" };

function box(over: Partial<CheckboxElement> = {}): CheckboxElement {
	return freezeElement({ id: "c1", type: "checkbox", x: 100, y: 100, size: 20, color: "#1f2430", ...over });
}

function docWith(...boxes: CheckboxElement[]): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	doc.pages[0]!.id = "p1";
	doc.pages[0]!.elements = boxes;
	return doc;
}

// ------------------------------------------------------------------ L1

describe("L1: a label cut at the limit never ends in a space", () => {
	const long = `${"a".repeat(CHECKBOX_LABEL_MAX - 1)} ${"b".repeat(30)}`;

	it("trims again after the cut", () => {
		expect(long[CHECKBOX_LABEL_MAX - 1]).toBe(" ");
		const clean = cleanCheckboxLabel(long);
		expect(clean).toBe("a".repeat(CHECKBOX_LABEL_MAX - 1));
		expect(cleanCheckboxLabel(clean)).toBe(clean);
		expect(cleanCheckboxLabel(`${"é ".repeat(300)}`).endsWith(" ")).toBe(false);
	});

	it("a task text of 201 to 300 characters whose 200th is a space can still be saved", () => {
		const doc = docWith(withCheckboxLabel(box(), long));
		const out = serializeChecked(doc);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		const back = parse(out.text);
		expect(back.ok).toBe(true);
		if (back.ok) expect((back.doc.pages[0]!.elements![0] as CheckboxElement).label).toBe("a".repeat(CHECKBOX_LABEL_MAX - 1));
	});

	it("the label command goes through the same cut", () => {
		const doc = docWith(box());
		const history = new History(() => doc, 100, null);
		expect(history.execute(setCheckboxLabel("p1", "c1", long))).toBe(true);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("a stored label with a trailing space is not what this plugin writes: refused strictly, normalised leniently", () => {
		const raw = JSON.parse(serialize(docWith(box({ label: "x" })))) as Raw;
		setAt(raw, ["pages", 0, "elements", 0, "label"], "trailing ");
		const r = parse(JSON.stringify(raw));
		expect(r.ok && (r.doc.pages[0]!.elements![0] as CheckboxElement).label).toBe("trailing");
	});
});

// ------------------------------------------------------------------ L2, L3, L12

interface Fake {
	deps: SyncDeps;
	sync: ChecklistSync;
	state: { boxes: Array<{ id: string; checked: boolean; task: { path: string; block: string } }>; docId: string | null; now: number };
	writes: Array<{ path: string; checked: boolean }>;
	notices: Array<[SyncNotice, string, string | undefined]>;
	unlinked: string[];
	results: SyncResult[];
	throwOnce: { current: string | null };
	canUnlink: { current: boolean };
}

function fake(): Fake {
	const state: Fake["state"] = { boxes: [{ id: "c1", checked: false, task: { ...TASK } }], docId: "doc", now: 1000 };
	const writes: Fake["writes"] = [];
	const notices: Fake["notices"] = [];
	const unlinked: string[] = [];
	const results: SyncResult[] = [];
	const throwOnce = { current: null as string | null };
	const canUnlink = { current: true };
	const deps: SyncDeps = {
		snapshot: (): SyncSnapshot | null => (state.docId === null ? null : { docId: state.docId, boxes: state.boxes.map((b) => ({ ...b })) }),
		write: (task, checked) => {
			writes.push({ path: task.path, checked });
			if (throwOnce.current !== null) {
				const message = throwOnce.current;
				throwOnce.current = null;
				return Promise.reject(new Error(message));
			}
			return Promise.resolve(results.shift() ?? "ok");
		},
		unlink: (entry: SyncEntry) => {
			if (!canUnlink.current) return false;
			unlinked.push(entry.id);
			state.boxes = state.boxes.filter((b) => b.id !== entry.id);
			return true;
		},
		notify: (kind, entry, detail) => notices.push([kind, entry.task.path, detail]),
		now: () => state.now,
	};
	const sync = new ChecklistSync(deps);
	sync.baseline(deps.snapshot());
	return { deps, sync, state, writes, notices, unlinked, results, throwOnce, canUnlink };
}

describe("L2: a tick waiting for the delayed write is not lost", () => {
	it("is noted the moment the document changes and written whenever the write runs", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.sync.collect();
		expect(f.sync.pendingCount()).toBe(1);
		await f.sync.run();
		expect(f.writes).toEqual([{ path: TASK.path, checked: true }]);
		expect(f.sync.pendingCount()).toBe(0);
	});

	it("survives a reload of the same document that still has the tick (no re-baseline as written)", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.sync.collect();
		f.sync.baseline(f.deps.snapshot());
		expect(f.sync.pendingCount()).toBe(1);
		await f.sync.run();
		expect(f.writes).toHaveLength(1);
	});

	it("is dropped when the reloaded document no longer has the tick", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.sync.collect();
		f.state.boxes[0]!.checked = false;
		f.sync.baseline(f.deps.snapshot());
		expect(f.sync.pendingCount()).toBe(0);
		await f.sync.run();
		expect(f.writes).toHaveLength(0);
	});

	it("is written even when another document was opened meanwhile, and never unlinks that other document", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.sync.collect();
		f.state.docId = "other";
		f.state.boxes = [];
		f.sync.baseline(f.deps.snapshot());
		expect(f.sync.pendingCount()).toBe(1);
		await f.sync.run();
		expect(f.writes).toEqual([{ path: TASK.path, checked: true }]);
		expect(f.sync.pendingCount()).toBe(0);
	});

	it("an untick before the write cancels it, a second tick replaces the first", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.sync.collect();
		f.state.boxes[0]!.checked = false;
		f.sync.collect();
		expect(f.sync.pendingCount()).toBe(0);
		await f.sync.run();
		expect(f.writes).toHaveLength(0);
	});

	it("a failed write is tried again later, at growing intervals, and told once", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.throwOnce.current = "disk full";
		await f.sync.run();
		expect(f.writes).toHaveLength(1);
		expect(f.notices).toEqual([["failed", TASK.path, "disk full"]]);
		expect(f.sync.nextRetryIn()).toBe(RETRY_DELAYS[0]);
		await f.sync.run();
		expect(f.writes).toHaveLength(1); // too early
		f.state.now += RETRY_DELAYS[0] + 1;
		await f.sync.run();
		expect(f.writes).toHaveLength(2);
		expect(f.sync.pendingCount()).toBe(0);
		expect(f.notices).toHaveLength(1);
	});
});

describe("L3: a note that is not there keeps the link", () => {
	it("a missing note is not a gone line: nothing is unlinked, the write is retried later", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.results.push("missing");
		await f.sync.run();
		expect(f.unlinked).toEqual([]);
		expect(f.notices).toEqual([]);
		expect(f.sync.pendingCount()).toBe(1);
		f.state.now += RETRY_DELAYS[0] + 1;
		await f.sync.run(); // the note arrived
		expect(f.writes).toHaveLength(2);
		expect(f.sync.pendingCount()).toBe(0);
		expect(f.unlinked).toEqual([]);
	});

	it("gives up quietly after the last try, with one notice, and keeps the link", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		for (let i = 0; i < RETRY_DELAYS.length; i++) f.results.push("missing");
		for (let i = 0; i < RETRY_DELAYS.length; i++) {
			await f.sync.run();
			f.state.now += RETRY_DELAYS[i]! + 1;
		}
		expect(f.notices.map((n) => n[0])).toEqual(["missing"]);
		expect(f.unlinked).toEqual([]);
		expect(f.state.boxes).toHaveLength(1);
		f.state.now += 10 * 60_000;
		await f.sync.run();
		expect(f.writes).toHaveLength(RETRY_DELAYS.length); // no more tries until the checkbox is toggled again
	});

	it("only a line that is really gone unlinks, with a notice", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.results.push("gone", "gone");
		await f.sync.run();
		expect(f.unlinked).toEqual([]); // (N1: seen once is not enough)
		f.state.now += GONE_CONFIRM_MS + 1;
		await f.sync.run();
		expect(f.unlinked).toEqual(["c1"]);
		expect(f.notices.map((n) => n[0])).toEqual(["gone"]);
		expect(f.sync.pendingCount()).toBe(0);
	});

	it("follows a renamed note, and a note in a renamed folder", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.sync.collect();
		f.sync.renamed("Daily", "Journal");
		f.sync.renamed("Journal/2026-11-05.md", "Journal/today.md");
		await f.sync.run();
		expect(f.writes).toEqual([{ path: "Journal/today.md", checked: true }]);
		expect(renamedPath("a/b.md", "a/b.md", "c.md")).toBe("c.md");
		expect(renamedPath("a/b/c.md", "a/b", "x")).toBe("x/c.md");
		expect(renamedPath("ab/c.md", "a", "x")).toBeNull();
		expect(renamedPath("a.md", "", "x")).toBeNull();
	});
});

describe("L12: the unlink of a gone line is told only when it happened", () => {
	it("a refused unlink (a locked page, a read-only notebook) tells nothing and is tried again", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.canUnlink.current = false;
		f.results.push("gone", "gone");
		await f.sync.run();
		f.state.now += GONE_CONFIRM_MS + 1;
		await f.sync.run(); // seen twice: the unlink is refused
		expect(f.notices).toEqual([]);
		expect(f.sync.pendingCount()).toBe(1);
		f.canUnlink.current = true;
		f.results.push("gone");
		f.state.now += RETRY_DELAYS[1] + 1;
		await f.sync.run();
		expect(f.unlinked).toEqual(["c1"]);
		expect(f.notices.map((n) => n[0])).toEqual(["gone"]);
	});

	it("more than one line with the id: nothing is written, one notice, no more tries", async () => {
		const f = fake();
		f.state.boxes[0]!.checked = true;
		f.results.push("ambiguous");
		await f.sync.run();
		expect(f.notices.map((n) => n[0])).toEqual(["ambiguous"]);
		f.state.now += 10 * 60_000;
		await f.sync.run();
		expect(f.writes).toHaveLength(1);
		// toggling again is a new decision
		f.state.boxes[0]!.checked = false;
		f.sync.collect();
		expect(f.sync.pendingCount()).toBe(0);
	});
});

describe("the sync bookkeeping", () => {
	beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
	afterEach(() => vi.restoreAllMocks());

	it("a checkbox linked after opening is left alone until its next change", async () => {
		const f = fake();
		f.state.boxes.push({ id: "c9", checked: true, task: { path: "x.md", block: "nb-x" } });
		await f.sync.run();
		expect(f.writes).toHaveLength(0);
	});

	it("a quick run of changes to a checkbox that was just relinked (undo of an unlink, then undo of its tick) is one change", async () => {
		const f = fake();
		f.sync.linked("c1", null);
		f.state.boxes[0]!.checked = true;
		f.sync.collect(); // undo of the unlink: linked again, ticked, state of its line unknown
		expect(f.sync.hasWork()).toBe(true); // (the write that follows takes it in)
		f.state.boxes[0]!.checked = false;
		f.sync.collect(); // undo of the tick
		expect(f.sync.pendingCount()).toBe(0);
		await f.sync.run();
		expect(f.writes).toHaveLength(0);
		expect(f.sync.pendingCount()).toBe(0);
	});

	it("a checkbox just linked to a line written unticked writes its tick at the next change", async () => {
		const f = fake();
		f.state.boxes.push({ id: "c9", checked: true, task: { path: "x.md", block: "nb-x" } });
		f.sync.linked("c9", false);
		await f.sync.run();
		expect(f.writes).toEqual([{ path: "x.md", checked: true }]);
	});
});

// ------------------------------------------------------------------ L4, L5

describe("L4: a duplicated notebook is not linked to the tasks of the original", () => {
	it("patchNotebookId drops the links and their time, keeps the ticks, and says it changed", () => {
		const doc = docWith(box({ checked: true, at: T0, label: "x", task: TASK, taskAt: T0 }));
		const r = patchNotebookId(serialize(doc), "copy-id");
		expect(r.ok && r.changed).toBe(true);
		if (!r.ok) return;
		const back = parse(r.text);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		const el = back.doc.pages[0]!.elements![0] as CheckboxElement;
		expect(el).toMatchObject({ id: "c1", checked: true, at: T0, label: "x" });
		expect(el.task).toBeUndefined();
		expect(el.taskAt).toBeUndefined();
		expect(back.doc.id).toBe("copy-id");
	});

	it("unlinkChecklist returns the same page when nothing is linked", () => {
		const page = docWith(box()).pages[0]!;
		expect(unlinkChecklist(page)).toBe(page);
	});
});

describe("L5: a moved page keeps its links, a copy never does", () => {
	function source(): NotebookDocument {
		return docWith(box({ checked: true, at: T0, task: TASK, taskAt: T0 }));
	}
	const target = () => createDocument(new Date(stamp));

	it("duplicatePage drops the link unless the page is kept", () => {
		const page = source().pages[0]!;
		expect((duplicatePage(page).elements![0] as CheckboxElement).task).toBeUndefined();
		const kept = duplicatePage(page, { keepTasks: true }).elements![0] as CheckboxElement;
		expect(kept.task).toEqual(TASK);
		expect(kept.id).not.toBe("c1");
		expect(copiedCheckbox(box({ task: TASK }), "n", true).task).toEqual(TASK);
	});

	it("a move to another notebook keeps them, a copy drops them", () => {
		const moved = planTransfer(source(), ["p1"], target(), "move");
		const copied = planTransfer(source(), ["p1"], target(), "copy");
		if (!moved.ok || !copied.ok) throw new Error("plan failed");
		expect((moved.pages[0]!.elements![0] as CheckboxElement).task).toEqual(TASK);
		expect((copied.pages[0]!.elements![0] as CheckboxElement).task).toBeUndefined();
		const plain = planPageMove(source(), ["p1"], target());
		if (!plain.ok) throw new Error("plan failed");
		expect((plain.pages[0]!.elements![0] as CheckboxElement).task).toBeUndefined();
		const kept = planPageMove(source(), ["p1"], target(), true);
		if (!kept.ok) throw new Error("plan failed");
		expect((kept.pages[0]!.elements![0] as CheckboxElement).task).toEqual(TASK);
	});

	it("a page restored from the page trash keeps them even when its ids had to change", () => {
		const doc = source();
		const trash = addEntry(emptyPageTrash("doc"), makeEntry(doc, doc.pages[0]!, 0, Date.now()), Date.now());
		// (the page is still in the notebook: every id clashes, so the restore copies the page under new ids)
		const plan = planPageTrashRestore(doc, trash.entries[0]!)!;
		plan.command.apply(doc);
		const restored = doc.pages[plan.pageIndex]!.elements![0] as CheckboxElement;
		expect(restored.id).not.toBe("c1");
		expect(restored.task).toEqual(TASK);
	});
});

// ------------------------------------------------------------------ L6, L10

describe("L6: an unlink is not undone by merging an older copy", () => {
	it("setCheckboxTask stamps the change; linking to the same task changes nothing", () => {
		const doc = docWith(box({ task: TASK }));
		const history = new History(() => doc, 100, null);
		expect(history.execute(setCheckboxTask("p1", "c1", null, T0 + 50))).toBe(true);
		expect(checkboxesOf(doc.pages[0]!)[0]).toMatchObject({ taskAt: T0 + 50 });
		expect(checkboxesOf(doc.pages[0]!)[0]!.task).toBeUndefined();
		const before = doc.pages[0]!.elements![0];
		history.execute(setCheckboxTask("p1", "c1", null, T0 + 99));
		expect(doc.pages[0]!.elements![0]).toBe(before);
	});

	it("the main notebook's later unlink stands against the copy's link", () => {
		const main = box({ taskAt: T0 + 50 });
		const copy = box({ task: TASK, taskAt: T0 + 10 });
		expect(mergedCheckbox(main, copy)).toBeNull();
		const old = box({ task: TASK });
		expect(mergedCheckbox(main, old)).toBeNull();
	});

	it("the copy's later decision wins, link or unlink, and is stamped", () => {
		const linked = box({ task: TASK, taskAt: T0 + 1 });
		const unlinked = box({ taskAt: T0 + 5 });
		const a = mergedCheckbox(linked, unlinked)!;
		expect(a.task).toBeUndefined();
		expect(a.taskAt).toBe(T0 + 5);
		const b = mergedCheckbox(unlinked, box({ task: TASK, taskAt: T0 + 9 }))!;
		expect(b.task).toEqual(TASK);
		expect(b.taskAt).toBe(T0 + 9);
	});

	it("a link only the copy has is still taken when neither side ever decided", () => {
		expect(mergedCheckbox(box(), box({ task: TASK }))!.task).toEqual(TASK);
	});

	it("merging counts it and a copy with a later unlink is not covered until merged", () => {
		const main = docWith(box({ task: TASK, taskAt: T0 }));
		const other = docWith(box({ taskAt: T0 + 20 }));
		expect(mergeCovers(main, other)).toBe(false);
		const plan = planMerge(main, other);
		expect(plan.summary.checkboxesUpdated).toBe(1);
		const history = new History(() => main, 100, null);
		expect(history.execute(plan.command!)).toBe(true);
		expect(checkboxesOf(main.pages[0]!)[0]!.task).toBeUndefined();
		expect(mergeCovers(main, other)).toBe(true);
	});

	it("taskAt is written after the tick time, read back, and dropped alone when invalid", () => {
		const doc = docWith(box({ checked: true, at: T0, taskAt: T0 + 3, label: "x", task: TASK }));
		const text = serialize(doc);
		expect(text).toContain(`"at":${T0},"taskAt":${T0 + 3},"label":"x","task":`);
		const back = parse(text);
		expect(back.ok && (back.doc.pages[0]!.elements![0] as CheckboxElement).taskAt).toBe(T0 + 3);
		const raw = JSON.parse(text) as Raw;
		setAt(raw, ["pages", 0, "elements", 0, "taskAt"], "later");
		const bad = parse(JSON.stringify(raw));
		expect(bad.ok && bad.dropped).toBe(1);
		expect(bad.ok && (bad.doc.pages[0]!.elements![0] as CheckboxElement).taskAt).toBeUndefined();
	});

	it("a cleared or copied checkbox has no link time either", () => {
		const copy = copiedCheckbox(box({ task: TASK, taskAt: T0 }), "n");
		expect(copy.task).toBeUndefined();
		expect(copy.taskAt).toBeUndefined();
	});
});

describe("L10: a tie that disagrees keeps the tick", () => {
	it("equal times, different ticks: the tick wins whichever side has it", () => {
		const ticked = box({ checked: true, at: T0 });
		const open = box({ at: T0 });
		expect(mergedCheckbox(ticked, open)).toBeNull();
		expect(mergedCheckbox(open, ticked)).toMatchObject({ checked: true, at: T0 });
		// both without a time (a lenient read dropped an invalid one)
		expect(mergedCheckbox(box(), box({ checked: true }))).toMatchObject({ checked: true });
		expect(mergedCheckbox(box({ checked: true }), box())).toBeNull();
	});

	it("is not covered while the result lost the tick of the tie, and is after the merge", () => {
		const main = docWith(box({ at: T0 }));
		const other = docWith(box({ checked: true, at: T0 }));
		expect(mergeCovers(main, other)).toBe(false);
		const history = new History(() => main, 100, null);
		history.execute(planMerge(main, other).command!);
		expect(checkboxesOf(main.pages[0]!)[0]!.checked).toBe(true);
		expect(mergeCovers(main, other)).toBe(true);
	});
});

// ------------------------------------------------------------------ L8

describe("L8: the pen taps the box, not a finger-sized square", () => {
	const els = [box()];

	it("a dot just outside the box and its small margin is ink", () => {
		// the box spans 100..120; at phone zoom the finger target reaches far beyond it
		expect(checkboxAt(els, 132, 110, 0.6)).not.toBeNull();
		expect(checkboxAtPen(els, 132, 110)).toBeNull();
		expect(checkboxAtPen(els, 120 + PEN_TAP_MARGIN + 1, 110)).toBeNull();
	});

	it("the box itself and the margin around it are taps", () => {
		expect(checkboxAtPen(els, 110, 110)).toBe(els[0]);
		expect(checkboxAtPen(els, 120 + PEN_TAP_MARGIN, 100 - PEN_TAP_MARGIN)).toBe(els[0]);
	});

	it("the topmost box wins and other elements are skipped", () => {
		const a = box({ id: "a" });
		const b = box({ id: "b" });
		expect(checkboxAtPen([a, { type: "text" }, b], 110, 110)?.id).toBe("b");
	});
});

// ------------------------------------------------------------------ L9

describe("L9: the right task line", () => {
	it("skips fenced code blocks, also inside a quote, and the frontmatter", () => {
		const note = [
			"---", "example: - [ ] fake ^nb-a", "---",
			"```md", "- [ ] copy ^nb-a", "```",
			"> ~~~", "> - [ ] quoted copy ^nb-a", "> ~~~",
			"- [ ] real ^nb-a", "",
		].join("\n");
		const r = setTaskLineChecked(note, "nb-a", true);
		expect(r).toMatchObject({ found: true, changed: true });
		expect(r.text.split("\n")[9]).toBe("- [x] real ^nb-a");
		expect(r.text.split("\n")[4]).toBe("- [ ] copy ^nb-a");
		expect(r.text.split("\n")[7]).toBe("> - [ ] quoted copy ^nb-a");
	});

	it("only code is a copy: a line in a block that never closes counts as code, one after it as text", () => {
		expect(setTaskLineChecked("```\n- [ ] x ^nb-b", "nb-b", true).found).toBe(false);
		expect(setTaskLineChecked("```\n```\n- [ ] x ^nb-b", "nb-b", true).found).toBe(true);
		expect(setTaskLineChecked("````\n```\n- [ ] x ^nb-b\n````\n", "nb-b", true).found).toBe(false);
	});

	it("a task in a callout or a quote is found and keeps its prefix", () => {
		expect(setTaskLineChecked("> [!todo]\n> - [ ] in a callout ^nb-c\n", "nb-c", true).text).toBe("> [!todo]\n> - [x] in a callout ^nb-c\n");
		expect(setTaskLineChecked("> > 1. [ ] deep ^nb-c", "nb-c", true).text).toBe("> > 1. [x] deep ^nb-c");
	});

	it("a frontmatter that never closes is text", () => {
		expect(setTaskLineChecked("---\n- [ ] x ^nb-d\n", "nb-d", true).found).toBe(true);
	});

	it("two task lines with the id: nothing is changed and it is said", () => {
		const note = "- [ ] one ^nb-e\n- [ ] two ^nb-e\n";
		expect(setTaskLineChecked(note, "nb-e", true)).toEqual({ text: note, found: true, changed: false, ambiguous: true });
	});

	it("the id on something that is not a task is not a second line", () => {
		const note = "- [ ] one ^nb-f\nnot a task ^nb-f\n";
		expect(setTaskLineChecked(note, "nb-f", true).text).toBe("- [x] one ^nb-f\nnot a task ^nb-f\n");
	});
});

// ------------------------------------------------------------------ L13, L15, L16

describe("L13: the text does not promise the note ticks the checkbox", () => {
	it("says ticks go from the checkbox to the note, in both languages", () => {
		expect(en["checklist.task.desc"]).not.toMatch(/either one/i);
		expect(en["checklist.task.desc"]).toMatch(/does not tick the checkbox/);
		expect(itMessages["checklist.task.desc"]).not.toMatch(/anche l'altra/);
		expect(itMessages["checklist.task.desc"]).toMatch(/non spunta la casella/);
	});

	it("has the new texts in both languages", () => {
		for (const key of ["checklist.task.ambiguous", "checklist.task.pathTooLong", "checklist.task.noteMissing", "merge.summary.checkboxes", "merge.summary.markers"] as const) {
			expect(en[key]).toBeTruthy();
			expect(itMessages[key]).toBeTruthy();
		}
	});
});

describe("L15: a note path the format cannot hold is not linked", () => {
	it("tells what the strict writer accepts", () => {
		expect(isLinkablePath("Daily/2026-11-05.md")).toBe(true);
		expect(isLinkablePath("x".repeat(CHECKBOX_PATH_MAX))).toBe(true);
		expect(isLinkablePath("x".repeat(CHECKBOX_PATH_MAX + 1))).toBe(false);
		expect(isLinkablePath("")).toBe(false);
		expect(isLinkablePath("a\nb.md")).toBe(false);
	});

	it("a link over the limit would make the document unsavable, which is why it is refused before", () => {
		const doc = docWith(withCheckboxTask(box(), { path: "x".repeat(CHECKBOX_PATH_MAX + 1), block: "nb-a" }));
		expect(serializeChecked(doc).ok).toBe(false);
	});
});

describe("L16: the notebook map key follows the label", () => {
	it("changes when the label does", () => {
		const page = { ...createPage(), elements: [box({ label: "Buy milk" })] };
		const renamed = { ...page, elements: [box({ label: "Buy bread" })] };
		expect(mapKey(page)).not.toBe(mapKey(renamed));
		expect(mapKey(page)).toBe(mapKey({ ...page }));
	});
});
