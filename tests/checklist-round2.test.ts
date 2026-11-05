/**
 * Second review of the handwritten checklists (wave 0.19): a line is "gone" only for a note edited since the link was made and read
 * twice a minute apart, and never because a code block does not close (N1, N6); a renamed note is followed only to a path the format
 * can store (N3), not as an undo step, also when the notebook was closed at the time (N4); the automatic unlink is no undo step (N5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKBOX_PATH_MAX, setTaskLineChecked } from "../src/model/checklist";
import { toggleCheckbox } from "../src/model/checklist-commands";
import { ChecklistSync, GONE_CONFIRM_MS, RETRY_DELAYS, type SyncDeps, type SyncResult } from "../src/model/checklist-sync";
import { createDocument } from "../src/model/document";
import { History } from "../src/model/history";
import { addRename, normaliseRenames, RENAME_MAP_MAX, RENAME_MAP_TTL_MS, resolveRenamed } from "../src/model/rename-map";
import { freezeElement } from "../src/model/serialize";
import type { CheckboxElement, NotebookDocument } from "../src/model/types";
import { loadRenames, recordRename, RENAMED_NOTES_KEY } from "../src/storage/renamed-notes";
import { FakeVault } from "./fake-vault";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const { ChecklistTools } = await import("../src/view/checklist-tools");
const { Notice } = (await import("obsidian")) as unknown as { Notice: { shown: string[] } };

const NOTE = "Daily/2026-11-05.md";
const BLOCK = "nb-abc123";
const LINE = `- [ ] read chapter 4 ^${BLOCK}`;
const T_LINK = 1_760_000_000_000;

function linkedBox(over: Partial<CheckboxElement> = {}): CheckboxElement {
	return freezeElement({ id: "c1", type: "checkbox", x: 10, y: 10, size: 20, color: "#1f2430", task: { path: NOTE, block: BLOCK }, taskAt: T_LINK, ...over });
}

function docWith(box: CheckboxElement): NotebookDocument {
	const doc = createDocument(new Date("2026-11-05T10:00:00.000Z"));
	doc.id = "doc";
	doc.pages[0]!.id = "p1";
	doc.pages[0]!.elements = [box];
	return doc;
}

// ------------------------------------------------------------------ the unclosed fence (N6)

describe("N6: a code block that never closes is not a deleted line", () => {
	it("says so when the line is not found", () => {
		expect(setTaskLineChecked(`# Day\n\`\`\`\n${LINE}\n`, BLOCK, true)).toMatchObject({ found: false, unclosedFence: true });
		expect(setTaskLineChecked("# Day\n```\ncode\n```\n", BLOCK, true).unclosedFence).toBeUndefined();
		expect(setTaskLineChecked("# Day\nnothing\n", BLOCK, true).unclosedFence).toBeUndefined();
	});

	it("a line found before the block is found as before", () => {
		expect(setTaskLineChecked(`${LINE}\n\`\`\`\ncode\n`, BLOCK, true)).toMatchObject({ found: true, changed: true });
	});
});

// ------------------------------------------------------------------ the sync (N1)

function rig() {
	const state = { now: 10_000, box: { id: "c1", checked: false, task: { path: NOTE, block: BLOCK }, taskAt: T_LINK } };
	const results: SyncResult[] = [];
	const seen: number[] = [];
	const unlinked: string[] = [];
	const deps: SyncDeps = {
		snapshot: () => ({ docId: "doc", boxes: [{ ...state.box }] }),
		write: (_task, _checked, taskAt) => {
			seen.push(taskAt);
			return Promise.resolve(results.shift() ?? "ok");
		},
		unlink: (e) => {
			unlinked.push(e.id);
			return true;
		},
		notify: () => undefined,
		now: () => state.now,
	};
	const sync = new ChecklistSync(deps);
	sync.baseline(deps.snapshot());
	state.box.checked = true;
	return { sync, state, results, seen, unlinked };
}

describe("N1: a line is gone only when seen gone twice, a minute apart", () => {
	it("asks the writer with the time of the link", async () => {
		const r = rig();
		await r.sync.run();
		expect(r.seen).toEqual([T_LINK]);
	});

	it("one sight keeps the link, the second one a minute later unlinks", async () => {
		const r = rig();
		r.results.push("gone", "gone");
		await r.sync.run();
		expect(r.unlinked).toEqual([]);
		expect(r.sync.nextRetryIn()).toBe(GONE_CONFIRM_MS);
		r.state.now += GONE_CONFIRM_MS - 1;
		await r.sync.run(); // not yet due
		expect(r.seen).toHaveLength(1);
		r.state.now += 2;
		await r.sync.run();
		expect(r.unlinked).toEqual(["c1"]);
	});

	it("a note that is missing or has no line yet in between starts the count again", async () => {
		const r = rig();
		r.results.push("gone", "missing", "gone", "gone");
		await r.sync.run();
		r.state.now += GONE_CONFIRM_MS + 1;
		await r.sync.run(); // missing
		r.state.now += RETRY_DELAYS[1] + 1;
		await r.sync.run(); // gone, the first sight again
		expect(r.unlinked).toEqual([]);
		r.state.now += GONE_CONFIRM_MS + 1;
		await r.sync.run();
		expect(r.unlinked).toEqual(["c1"]);
	});

	it("a note where the line shows up in between is written and nothing is unlinked", async () => {
		const r = rig();
		r.results.push("gone", "ok");
		await r.sync.run();
		r.state.now += GONE_CONFIRM_MS + 1;
		await r.sync.run();
		expect(r.unlinked).toEqual([]);
		expect(r.sync.pendingCount()).toBe(0);
	});
});

// ------------------------------------------------------------------ the view

function viewRig(files: Record<string, string>, box: CheckboxElement = linkedBox()) {
	const fake = new FakeVault(files);
	const handlers: Array<(file: { path: string }, oldPath: string) => void> = [];
	const store = new Map<string, unknown>();
	const app = {
		vault: {
			...fake.vault,
			on: (name: string, fn: (file: { path: string }, oldPath: string) => void) => {
				if (name === "rename") handlers.push(fn);
				return {};
			},
		},
		loadLocalStorage: (k: string) => store.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => void store.set(k, v),
	};
	const doc = docWith(box);
	const history = new History(() => doc);
	let saves = 0;
	let locked = false;
	const host = {
		app,
		stage: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
		doc: () => doc,
		editable: () => true,
		execute: (cmd: never) => {
			const done = history.execute(cmd);
			saves++;
			return done;
		},
		maintain: (cmd: never) => {
			if (locked) return false;
			const done = history.applyQuietly(cmd);
			if (done) saves++;
			return done;
		},
		settings: () => ({}),
		register: () => undefined,
		refresh: () => undefined,
	};
	const tools = new ChecklistTools(host as never);
	const current = (): CheckboxElement => doc.pages[0]!.elements![0] as CheckboxElement;
	const tick = (): void => {
		host.execute(toggleCheckbox("p1", "c1", Date.now()) as never);
		tools.docChanged();
	};
	const touch = (path: string, mtime: number): void => {
		(fake.vault.getFileByPath(path) as unknown as { stat: { mtime: number } }).stat.mtime = mtime;
	};
	return { fake, handlers, store, app, doc, history, tools, current, tick, touch, saves: () => saves, lock: (v: boolean) => (locked = v) };
}

describe("the view", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
		vi.stubGlobal("window", { setTimeout, clearTimeout, navigator: {} });
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		Notice.shown.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	describe("N1: an older copy of the note keeps the link", () => {
		it("a note not edited since the link was made, without the line, is not a deleted line", async () => {
			const r = viewRig({ [NOTE]: "# 2026-11-05\n" });
			r.touch(NOTE, T_LINK - 1000);
			r.tick();
			await r.tools.reconcile();
			vi.setSystemTime(Date.now() + GONE_CONFIRM_MS + 1);
			await r.tools.reconcile();
			expect(r.current().task).toBeDefined();
			expect(r.current().checked).toBe(true);
			expect(r.fake.files.get(NOTE)).toBe("# 2026-11-05\n");
			r.tools.destroy();
		});

		it("the line arrives with the next sync: the tick is written and the link was never lost", async () => {
			const r = viewRig({ [NOTE]: "# 2026-11-05\n" });
			r.touch(NOTE, T_LINK - 1000);
			r.tick();
			await r.tools.reconcile();
			r.fake.put(NOTE, `# 2026-11-05\n${LINE}\n`);
			r.touch(NOTE, T_LINK + 5000);
			vi.setSystemTime(Date.now() + RETRY_DELAYS[0] + 1);
			await r.tools.reconcile();
			expect(r.fake.files.get(NOTE)).toBe(`# 2026-11-05\n- [x] read chapter 4 ^${BLOCK}\n`);
			expect(r.current().task).toBeDefined();
			r.tools.destroy();
		});

		it("a note edited since, read twice a minute apart without the line, is unlinked", async () => {
			const r = viewRig({ [NOTE]: "# 2026-11-05\n" });
			r.touch(NOTE, T_LINK + 5000);
			r.tick();
			await r.tools.reconcile();
			expect(r.current().task).toBeDefined();
			vi.setSystemTime(Date.now() + GONE_CONFIRM_MS + 1);
			await r.tools.reconcile();
			expect(r.current().task).toBeUndefined();
			expect(r.current().checked).toBe(true);
			r.tools.destroy();
		});
	});

	describe("N6: an unclosed code block above the line", () => {
		it("does not unlink, however often it is read", async () => {
			const r = viewRig({ [NOTE]: `# Day\n\`\`\`\n${LINE}\n` });
			r.touch(NOTE, T_LINK + 5000);
			r.tick();
			await r.tools.reconcile();
			vi.setSystemTime(Date.now() + GONE_CONFIRM_MS + 1);
			await r.tools.reconcile();
			vi.setSystemTime(Date.now() + GONE_CONFIRM_MS + RETRY_DELAYS[1]);
			await r.tools.reconcile();
			expect(r.current().task).toBeDefined();
			r.tools.destroy();
		});
	});

	describe("N5: the automatic unlink is no undo step", () => {
		it("Undo after the tick un-ticks, whatever the unlink did to the checkbox in between", async () => {
			const r = viewRig({ [NOTE]: "# 2026-11-05\n" });
			r.touch(NOTE, T_LINK + 5000);
			r.tick();
			await r.tools.reconcile();
			vi.setSystemTime(Date.now() + GONE_CONFIRM_MS + 1);
			const before = r.saves();
			await r.tools.reconcile();
			expect(r.current().task).toBeUndefined();
			expect(r.saves()).toBe(before + 1); // saved
			expect(r.history.undo()).not.toBeNull(); // the tick, not the unlink
			expect(r.current().checked).toBeUndefined();
			expect(r.current().task).toBeUndefined();
			expect(r.history.undo()).toBeNull();
			// and redo ticks again
			expect(r.history.redo()).not.toBeNull();
			expect(r.current().checked).toBe(true);
			r.tools.destroy();
		});

		it("a refused unlink (locked page) is tried again later, quietly", async () => {
			const r = viewRig({ [NOTE]: "# 2026-11-05\n" });
			r.touch(NOTE, T_LINK + 5000);
			r.lock(true);
			r.tick();
			await r.tools.reconcile();
			vi.setSystemTime(Date.now() + GONE_CONFIRM_MS + 1);
			await r.tools.reconcile();
			expect(r.current().task).toBeDefined();
			expect(Notice.shown).toEqual([]);
			r.tools.destroy();
		});
	});

	describe("N3: a rename to a path the format cannot store", () => {
		it("keeps the old link and says so once", async () => {
			const r = viewRig({ [NOTE]: `${LINE}\n` });
			const long = `${"d/".repeat(CHECKBOX_PATH_MAX)}x.md`;
			for (const h of r.handlers) h({ path: long }, NOTE);
			expect(r.current().task?.path).toBe(NOTE);
			expect(Notice.shown).toHaveLength(1);
			// a tick waiting for the note is not sent to the path either
			r.tick();
			await r.tools.reconcile();
			expect(r.fake.files.get(NOTE)).toBe(`- [x] read chapter 4 ^${BLOCK}\n`);
			r.tools.destroy();
		});

		it("a path that fits is followed", () => {
			const r = viewRig({ [NOTE]: `${LINE}\n` });
			for (const h of r.handlers) h({ path: "Journal/today.md" }, NOTE);
			expect(r.current().task?.path).toBe("Journal/today.md");
			expect(Notice.shown).toEqual([]);
			r.tools.destroy();
		});
	});

	describe("N4: a rename is no undo step", () => {
		// (the renames are remembered for 30 days: the clock is just after the links of these tests were made)
		beforeEach(() => vi.setSystemTime(T_LINK + 2000));

		it("following a renamed note is saved but Undo does not point the link back", () => {
			const r = viewRig({ [NOTE]: `${LINE}\n` });
			r.tick();
			const before = r.saves();
			for (const h of r.handlers) h({ path: "Journal/today.md" }, NOTE);
			expect(r.current().task?.path).toBe("Journal/today.md");
			expect(r.saves()).toBe(before + 1);
			expect(r.history.undo()).not.toBeNull(); // the tick
			expect(r.current().checked).toBeUndefined();
			expect(r.current().task?.path).toBe("Journal/today.md");
			expect(r.history.undo()).toBeNull();
			r.tools.destroy();
		});

		it("a note renamed while the notebook was closed is found again when the notebook opens", () => {
			const r = viewRig({ "Journal/today.md": `${LINE}\n` });
			// (the plugin saw the rename with no notebook open)
			recordRename(r.app, NOTE, "Journal/today.md", T_LINK + 1000);
			vi.setSystemTime(T_LINK + 2000);
			r.tools.reset();
			expect(r.current().task?.path).toBe("Journal/today.md");
			expect(r.history.undo()).toBeNull();
			r.tools.destroy();
		});

		it("a rename older than the link does not apply, and an old path that exists again is left alone", () => {
			const r = viewRig({ "Journal/today.md": `${LINE}\n` });
			recordRename(r.app, NOTE, "Journal/today.md", T_LINK - 1000);
			r.tools.reset();
			expect(r.current().task?.path).toBe(NOTE);
			r.fake.put(NOTE, `${LINE}\n`);
			recordRename(r.app, NOTE, "Journal/today.md", T_LINK + 1000);
			r.tools.reset();
			expect(r.current().task?.path).toBe(NOTE);
			r.tools.destroy();
		});

		it("a tick finds the renamed note through the record before anything is decided", async () => {
			const r = viewRig({ "Journal/today.md": `${LINE}\n` });
			recordRename(r.app, NOTE, "Journal/today.md", T_LINK + 1000);
			r.tick();
			await r.tools.reconcile();
			expect(r.fake.files.get("Journal/today.md")).toBe(`- [x] read chapter 4 ^${BLOCK}\n`);
			expect(r.current().task?.path).toBe("Journal/today.md");
			r.tools.destroy();
		});
	});
});

// ------------------------------------------------------------------ the record of renames and quiet commands

describe("the record of renames", () => {
	const NOW = T_LINK + 10_000;

	it("follows a chain and a folder, in the order it happened", () => {
		let list = addRename([], "Daily", "Journal", NOW - 3000);
		list = addRename(list, "Journal/a.md", "Journal/b.md", NOW - 2000);
		list = addRename(list, "Journal/b.md", "Archive/b.md", NOW - 1000);
		expect(resolveRenamed(list, "Daily/a.md")).toBe("Archive/b.md");
		expect(resolveRenamed(list, "Other/x.md")).toBe("Other/x.md");
		expect(resolveRenamed(list, "Daily/a.md", NOW - 1500)).toBe("Daily/a.md"); // (only what happened after the link)
	});

	it("does not store what a folder rename already explains, bounds and forgets", () => {
		let list = addRename([], "Daily", "Journal", NOW - 1000);
		list = addRename(list, "Daily/a.md", "Journal/a.md", NOW - 900);
		expect(list).toHaveLength(1);
		for (let i = 0; i < RENAME_MAP_MAX + 20; i++) list = addRename(list, `n${i}.md`, `m${i}.md`, NOW + i * 100_000);
		expect(list.length).toBe(RENAME_MAP_MAX);
		expect(list[list.length - 1]!.to).toBe(`m${RENAME_MAP_MAX + 19}.md`);
		expect(normaliseRenames([{ from: "a.md", to: "b.md", at: NOW - RENAME_MAP_TTL_MS - 1 }, { from: "", to: "b.md", at: NOW }, "x", { from: "a", to: "a", at: NOW }], NOW)).toEqual([]);
	});

	it("is kept in local storage; unreadable data reads as empty", () => {
		const store = new Map<string, unknown>();
		const app = { loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => void store.set(k, v) };
		recordRename(app, "a.md", "b.md", NOW);
		expect(loadRenames(app, NOW)).toEqual([{ from: "a.md", to: "b.md", at: NOW }]);
		store.set(RENAMED_NOTES_KEY, "garbage");
		expect(loadRenames(app, NOW)).toEqual([]);
		expect(loadRenames({ loadLocalStorage: () => { throw new Error("no"); }, saveLocalStorage: () => undefined }, NOW)).toEqual([]);
	});
});

describe("History.applyQuietly", () => {
	it("applies without recording, keeps the redo steps, and is refused when locked", () => {
		const doc = docWith(linkedBox());
		let locked = false;
		const history = new History(() => doc, 500, null, null, () => locked);
		history.execute(toggleCheckbox("p1", "c1", 1));
		history.undo();
		expect(history.applyQuietly(toggleCheckbox("p1", "c1", 2))).toBe(true);
		expect(history.redo()).not.toBeNull(); // the redo step was kept
		locked = true;
		expect(history.applyQuietly(toggleCheckbox("p1", "c1", 3))).toBe(false);
	});
});
