/**
 * 0.19 (#221): the lecture log. Pure line-building and merge, then the service on an in-memory vault: one line per lecture,
 * rewritten in place, nothing else in the note touched, no note made unless allowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument } from "../src/model/document";
import {
	addPending, buildLectureLine, lectureLogId, lectureSnapshot, mergeLectureLine, normaliseLogHeading, normalisePending, ownLineState, removePending,
} from "../src/library/lecture-log-logic";
import { buildLecturePage } from "../src/view/lecture-logic";
import { FakeVault } from "./fake-vault";

vi.mock("obsidian", async () => {
	const base = (await import("./fake-vault")).obsidianMock();
	const pad = (n: number): string => String(n).padStart(2, "0");
	return { ...base, moment: (d: Date) => ({ format: () => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }) };
});

const { LectureLogService } = await import("../src/library/lecture-log");

const DAY = new Date(2026, 10, 4, 10, 15);
const ID = lectureLogId("Notebooks/Analysis I.notebook", "c1@2026-11-04");
const H = "## Lectures";

describe("heading", () => {
	it("defaults, and adds the hashes the user left out", () => {
		expect(normaliseLogHeading("")).toBe("## Lectures");
		expect(normaliseLogHeading("  ##  ")).toBe("## Lectures");
		expect(normaliseLogHeading("Classes")).toBe("## Classes");
		expect(normaliseLogHeading("### Uni\nx")).toBe("### Uni x");
		expect(normaliseLogHeading(7)).toBe("## Lectures");
	});
});

describe("id and line", () => {
	it("the id is stable and differs per notebook and occurrence", () => {
		expect(ID).toMatch(/^nb-lec-[0-9a-z]{7}$/);
		expect(lectureLogId("Notebooks/Analysis I.notebook", "c1@2026-11-04")).toBe(ID);
		expect(lectureLogId("Notebooks/Other.notebook", "c1@2026-11-04")).not.toBe(ID);
		expect(lectureLogId("Notebooks/Analysis I.notebook", "c1@2026-11-11")).not.toBe(ID);
	});

	it("builds the line with the block id last", () => {
		const line = buildLectureLine({ start: "10:15", end: "11:45", course: "Analysis I", link: "[[A#p12|pp. 12–15]]", counts: ["3 pages", "2 open questions"] }, ID);
		expect(line).toBe(`- 10:15–11:45 **Analysis I** · 3 pages · 2 open questions — [[A#p12|pp. 12–15]] ^${ID}`);
		expect(buildLectureLine({ start: "9:00", end: "10:00", course: "A *b*\n[c]", link: "[[x]]", counts: [""] }, ID)).toBe(`- 9:00–10:00 **A b c** — [[x]] ^${ID}`);
	});

	it("a course name cannot comment out, tag, highlight or end the line (M10)", () => {
		const line = buildLectureLine({ start: "9:00", end: "10:00", course: "Intro %% #tag $x$ ==hi== <!-- end\\", link: "[[x]]", counts: [""] }, ID);
		const course = /\*\*(.*)\*\* — /.exec(line)![1]!;
		expect(course).not.toMatch(/(^|[^\\])(%%|#|\$|==|<)/);
		expect(course.endsWith("\\\\")).toBe(true);
	});

	it("the id follows the notebook's document id, not its path (M11)", () => {
		expect(lectureLogId("doc-1", "c1@2026-11-04")).toBe(lectureLogId("doc-1", "c1@2026-11-04"));
		expect(lectureLogId("doc-1", "c1@2026-11-04")).not.toBe(lectureLogId("doc-2", "c1@2026-11-04"));
	});
});

describe("snapshot", () => {
	const d1 = new Date(2026, 10, 4);
	const d0 = new Date(2026, 10, 3);
	const page = (course: string, d: Date) => buildLecturePage(undefined, course, d);
	const plain = () => createDocument(d1).pages[0]!;
	const question = (done: boolean) => ({ id: `q${Math.random()}`, type: "marker" as const, kind: "question" as const, x: 1, y: 1, ...(done ? { done: true as const } : {}) });

	it("spans the lecture page up to the next dated page and counts open questions", () => {
		const lec = page("Analysis I", d1);
		lec.elements = [...(lec.elements ?? []), question(false), question(true)];
		const mid = plain();
		mid.elements = [question(false)];
		const pages = [page("Analysis I", d0), lec, mid, plain(), page("Analysis I", new Date(2026, 10, 5))];
		const s = lectureSnapshot(pages, "Analysis I", d1);
		expect(s).toEqual({ first: 2, last: 4, firstId: lec.id, pages: 3, openQuestions: 2 });
	});

	it("is null without the lecture page", () => {
		expect(lectureSnapshot([plain()], "Analysis I", d1)).toBeNull();
	});
});

describe("merge", () => {
	const gen = (n: string): string => `10:15–11:45 **A** · ${n} — [[N#p1|p. 1]]`;
	const line = `- ${gen("1 page")} ^${ID}`;

	it("creates the heading at the end of a note that lacks it", () => {
		expect(mergeLectureLine("# Day\ntext\n", H, line, ID)).toBe(`# Day\ntext\n\n${H}\n${line}\n`);
		expect(mergeLectureLine("# Day", H, line, ID)).toBe(`# Day\n\n${H}\n${line}\n`);
		expect(mergeLectureLine("", H, line, ID)).toBe(`${H}\n${line}\n`);
		expect(mergeLectureLine("a\r\nb\r\n", H, line, ID)).toBe(`a\r\nb\r\n\r\n${H}\r\n${line}\r\n`);
	});

	it("adds under an existing heading, after its last line and before the next heading", () => {
		const text = `# Day\n${H}\n- earlier\n\n## Notes\nmore\n`;
		expect(mergeLectureLine(text, H, line, ID)).toBe(`# Day\n${H}\n- earlier\n${line}\n\n## Notes\nmore\n`);
		expect(mergeLectureLine(`${H}\n## Notes\n`, H, line, ID)).toBe(`${H}\n${line}\n## Notes\n`);
		expect(mergeLectureLine(`${H}\n- a`, H, line, ID)).toBe(`${H}\n- a\n${line}`);
		// a deeper heading belongs to the section; a same-level one ends it; a heading inside a code fence is not one
		expect(mergeLectureLine(`${H}\n### Sub\n- a\n# Top\n`, H, line, ID)).toBe(`${H}\n### Sub\n- a\n${line}\n# Top\n`);
		expect(mergeLectureLine("```\n## Lectures\n```\n", H, line, ID)).toBe(`\`\`\`\n## Lectures\n\`\`\`\n\n${H}\n${line}\n`);
	});

	it("rewrites only its own line, in place, and is idempotent", () => {
		const first = mergeLectureLine(`x\n${H}\n- other\n`, H, line, ID) as string;
		expect(mergeLectureLine(first, H, line, ID)).toBeNull();
		const later = `- ${gen("4 pages")} ^${ID}`;
		const second = `${first}\ntail 4\n`;
		expect(mergeLectureLine(second, H, later, ID)).toBe(`x\n${H}\n- other\n${later}\n\ntail 4\n`);
	});

	it("leaves another occurrence's line alone and keeps a moved line where the user put it", () => {
		const other = `- 8:00–9:00 **B** — [[y]] ^${lectureLogId("n", "k")}`;
		const text = `intro\n${other}\n## Elsewhere\n  - ${gen("old")} ^${ID}\r\nend`;
		const out = mergeLectureLine(text, H, line, ID) as string;
		expect(out).toBe(`intro\n${other}\n## Elsewhere\n  ${line}\r\nend`);
	});

	it("keeps what the user put in front of the line and after its link (M1)", () => {
		const later = `- ${gen("4 pages")} ^${ID}`;
		// moved into a callout, turned into a task, a note added after the link, all together
		expect(mergeLectureLine(`> [!note]\n> - ${gen("1 page")} ^${ID}\n`, H, later, ID)).toBe(`> [!note]\n> - ${gen("4 pages")} ^${ID}\n`);
		expect(mergeLectureLine(`- [ ] ${gen("1 page")} ^${ID}\n`, H, later, ID)).toBe(`- [ ] ${gen("4 pages")} ^${ID}\n`);
		expect(mergeLectureLine(`- [x] ${gen("1 page")} ^${ID}\n`, H, later, ID)).toBe(`- [x] ${gen("4 pages")} ^${ID}\n`);
		expect(mergeLectureLine(`* ${gen("1 page")} - revise ch. 3 ^${ID}\n`, H, later, ID)).toBe(`* ${gen("4 pages")} - revise ch. 3 ^${ID}\n`);
		expect(mergeLectureLine(`> > - [ ] ${gen("1 page")} my words ^${ID}`, H, later, ID)).toBe(`> > - [ ] ${gen("4 pages")} my words ^${ID}`);
		// idempotent with the user's additions
		expect(mergeLectureLine(`- [ ] ${gen("4 pages")} my words ^${ID}\n`, H, later, ID)).toBeNull();
		// a markdown link with parentheses in its address ends where it should
		const md = (u: string): string => `10:15–11:45 **A** · 1 page — [p. 1](${u})`;
		expect(mergeLectureLine(`- ${md("N%20(1).notebook")} mine ^${ID}\n`, H, `- ${md("N%20(2).notebook")} ^${ID}`, ID)).toBe(`- ${md("N%20(2).notebook")} mine ^${ID}\n`);
	});

	it("leaves a line the user turned into something else alone, and adds nothing (M1)", () => {
		const later = `- ${gen("4 pages")} ^${ID}`;
		const text = `${H}\n- my own rewrite of the lecture ^${ID}\n`;
		expect(mergeLectureLine(text, H, later, ID)).toBeNull();
		expect(ownLineState(text, ID)).toBe("altered");
		expect(ownLineState(`- ${gen("1 page")} ^${ID}`, ID)).toBe("ours");
		expect(ownLineState("nothing here", ID)).toBe("none");
	});

	it("never rewrites a copy inside a code fence (M1)", () => {
		const later = `- ${gen("4 pages")} ^${ID}`;
		const fenced = `\`\`\`\n- ${gen("1 page")} ^${ID}\n\`\`\`\n`;
		expect(ownLineState(fenced, ID)).toBe("none");
		// no line of ours outside the fence: a fresh one is added, the fenced copy stays as it was
		expect(mergeLectureLine(fenced, H, later, ID)).toBe(`${fenced}\n${H}\n${later}\n`);
		// the real line outside the fence is the one rewritten
		const both = `\`\`\`\n- ${gen("1 page")} ^${ID}\n\`\`\`\n- ${gen("2 pages")} ^${ID}\n`;
		expect(mergeLectureLine(both, H, later, ID)).toBe(`\`\`\`\n- ${gen("1 page")} ^${ID}\n\`\`\`\n${later}\n`);
	});

	it("does not mistake text that merely contains the id for its line", () => {
		const text = `see ^${ID} here\n`;
		expect(mergeLectureLine(text, H, line, ID)).toBe(`${text}\n${H}\n${line}\n`);
	});
});

describe("pending list", () => {
	const row = (id: string, day: string) => ({ id, day, notePath: "Daily/x.md", line: `- l ^${id}` });
	it("keeps good rows, drops bad and old ones, bounds the list", () => {
		const good = row("nb-lec-abc", "2026-11-04");
		const rows = [good, row("nb-lec-old", "2026-01-01"), { ...good, id: "bad id" }, { ...row("nb-lec-nl", "2026-11-04"), line: "a\nb ^nb-lec-nl" }, "x", null, { ...row("nb-lec-zz", "2026-11-04"), line: "no id" }];
		expect(normalisePending(rows, "2026-11-05")).toEqual([good]);
		expect(normalisePending("junk", "2026-11-05")).toEqual([]);
		const many = Array.from({ length: 50 }, (_, i) => row(`nb-lec-${i}`, "2026-11-04"));
		expect(normalisePending(many, "2026-11-05")).toHaveLength(30);
		expect(normalisePending(many, "2026-11-05")[29]?.id).toBe("nb-lec-49");
	});

	it("adds (replacing the same id) and removes", () => {
		const a = row("nb-lec-a", "2026-11-04");
		const a2 = { ...a, line: "- new ^nb-lec-a" };
		const list = addPending(addPending([], a, "2026-11-04"), a2, "2026-11-04");
		expect(list).toEqual([a2]);
		expect(removePending(list, "nb-lec-a")).toEqual([]);
	});
});

// ------------------------------------------------------------------------ the service

const NB = "Notebooks/Analysis I.notebook";
const cls = { key: "c1@2026-11-04", course: "Analysis I", start: "10:15", end: "11:45", startsAt: DAY.getTime(), endsAt: new Date(2026, 10, 4, 11, 45).getTime() };
const snap = { first: 12, last: 15, firstId: "pgabcdef12", pages: 4, openQuestions: 2 };

function rig(notes: Record<string, string>, settings: Record<string, unknown>) {
	const vault = new FakeVault({ [NB]: "{}", ...notes });
	const store = new Map<string, unknown>();
	const app = {
		vault: vault.vault,
		internalPlugins: { getPluginById: () => ({ enabled: true, instance: { options: { folder: "Daily", format: "YYYY-MM-DD" } } }) },
		fileManager: { generateMarkdownLink: (f: { path: string }, _from: string, sub?: string, alias?: string) => `[[${f.path}${sub ?? ""}${alias ? `|${alias}` : ""}]]` },
		loadLocalStorage: (k: string) => store.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => void store.set(k, v),
	};
	const plugin = { app, settings: { lectureLog: true, lectureLogHeading: "", dailyCreateNote: false, ...settings } };
	const service = new LectureLogService(plugin as never, 0);
	const file = vault.vault.getFileByPath(NB) as never;
	return { vault, store, plugin, service, file };
}

describe("service", () => {
	const NOTE = "Daily/2026-11-04.md";

	// The pending list drops rows older than 21 days against today's date: the clock is the class day.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 10, 4, 12, 0));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("adds the line under a new heading, then updates it in place when the session goes on", async () => {
		const r = rig({ [NOTE]: "# Today\n- a thing\n" }, {});
		await r.service.log(r.file, cls, snap);
		const first = r.vault.files.get(NOTE) as string;
		expect(first).toMatch(/^# Today\n- a thing\n\n## Lectures\n- 10:15–11:45 \*\*Analysis I\*\* · 4 pages · 2 open questions — \[\[Notebooks\/Analysis I\.notebook#p12&id=pgabcdef12\|pp\. 12–15\]\] \^nb-lec-[0-9a-z]+\n$/);
		await r.service.log(r.file, cls, snap);
		expect(r.vault.files.get(NOTE)).toBe(first);
		await r.service.log(r.file, cls, { ...snap, last: 17, pages: 6, openQuestions: 0 });
		const third = r.vault.files.get(NOTE) as string;
		expect(third.split("\n").filter((l) => l.includes("Analysis I"))).toHaveLength(1);
		expect(third).toContain("· 6 pages — [[Notebooks/Analysis I.notebook#p12&id=pgabcdef12|pp. 12–17]] ^nb-lec-");
		expect(third.startsWith("# Today\n- a thing\n\n## Lectures\n")).toBe(true);
	});

	it("does nothing when the setting is off", async () => {
		const r = rig({ [NOTE]: "x\n" }, { lectureLog: false });
		await r.service.log(r.file, cls, snap);
		expect(r.vault.files.get(NOTE)).toBe("x\n");
	});

	it("never makes a missing note without dailyCreateNote: the line waits, then is written once the note exists", async () => {
		const r = rig({}, {});
		await r.service.log(r.file, cls, snap);
		expect(r.vault.files.has(NOTE)).toBe(false);
		expect(r.service.waitingPaths()).toEqual([NOTE]);
		await r.service.flushPending();
		expect(r.vault.files.has(NOTE)).toBe(false);
		r.vault.put(NOTE, "# Day\n");
		await r.service.flushPending();
		expect(r.vault.files.get(NOTE)).toMatch(/^# Day\n\n## Lectures\n- 10:15–11:45 /);
		// written, but kept until a later read of the note shows the line
		expect(r.service.waitingPaths()).toEqual([NOTE]);
		await r.service.flushPending();
		expect(r.service.waitingPaths()).toEqual([]);
	});

	it("makes the note when dailyCreateNote is on", async () => {
		const r = rig({}, { dailyCreateNote: true, lectureLogHeading: "Classes" });
		await r.service.log(r.file, cls, snap);
		expect(r.vault.files.get(NOTE)).toMatch(/^## Classes\n- 10:15–11:45 \*\*Analysis I\*\*/);
		await r.service.flushPending();
		expect(r.service.waitingPaths()).toEqual([]);
	});

	it("a template that overwrites the new daily note afterwards does not lose the line (M2)", async () => {
		const r = rig({}, { dailyCreateNote: true });
		await r.service.log(r.file, cls, snap);
		expect(r.vault.files.get(NOTE)).toContain("## Lectures");
		// Templater writes its template over the note a moment later: the line is gone, the entry is still there.
		r.vault.put(NOTE, "# 2026-11-04\n\nTemplate text\n");
		expect(r.service.waitingPaths()).toEqual([NOTE]);
		await r.service.flushPending();
		expect(r.vault.files.get(NOTE)).toMatch(/^# 2026-11-04\n\nTemplate text\n\n## Lectures\n- 10:15–11:45 \*\*Analysis I\*\*/);
		// seen on the next look: settled for good
		await r.service.flushPending();
		expect(r.service.waitingPaths()).toEqual([]);
		// and a line the user removes afterwards is not written back
		r.vault.put(NOTE, "# 2026-11-04\n");
		await r.service.flushPending();
		expect(r.vault.files.get(NOTE)).toBe("# 2026-11-04\n");
	});

	it("a line that keeps vanishing is given up after a few tries", async () => {
		const r = rig({ [NOTE]: "x\n" }, {});
		await r.service.log(r.file, cls, snap);
		for (let i = 0; i < 6; i++) {
			r.vault.put(NOTE, "x\n");
			await r.service.flushPending();
		}
		expect(r.service.waitingPaths()).toEqual([]);
		expect(r.vault.files.get(NOTE)).toBe("x\n");
	});

	it("keeps what the user put around the line when the session goes on (M1)", async () => {
		const r = rig({ [NOTE]: "# Today\n" }, {});
		await r.service.log(r.file, cls, snap);
		await r.service.flushPending();
		const own = (r.vault.files.get(NOTE) as string).split("\n").find((l) => l.includes("Analysis I"))!;
		// the user moves the line into a callout, ticks it as a task and adds a word
		const edited = `> [!tip] Today\n> - [ ] ${own.slice(2).replace(/ \^(nb-lec-\w+)$/, " fine ^$1")}\n`;
		r.vault.put(NOTE, edited);
		await r.service.log(r.file, cls, { ...snap, last: 17, pages: 6, openQuestions: 0 });
		const out = r.vault.files.get(NOTE) as string;
		expect(out).toMatch(/^> \[!tip\] Today\n> - \[ \] 10:15–11:45 \*\*Analysis I\*\* · 6 pages — \[\[[^\]]*pp\. 12–17\]\] fine \^nb-lec-\w+\n$/);
	});

	it("leaves a line the user rewrote alone: nothing changed, nothing added (M1)", async () => {
		const r = rig({ [NOTE]: "# Today\n" }, {});
		await r.service.log(r.file, cls, snap);
		await r.service.flushPending();
		const id = /\^(nb-lec-\w+)/.exec(r.vault.files.get(NOTE) as string)![1];
		const mine = `# Today\n- I wrote this myself ^${id}\n`;
		r.vault.put(NOTE, mine);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await r.service.log(r.file, cls, { ...snap, pages: 9 });
		expect(r.vault.files.get(NOTE)).toBe(mine);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("does not create the notes of past days when the setting is turned on later (M9)", async () => {
		const r = rig({}, {});
		await r.service.log(r.file, cls, snap);
		expect(r.service.waitingPaths()).toEqual([NOTE]);
		(r.plugin.settings as { dailyCreateNote: boolean }).dailyCreateNote = true;
		vi.setSystemTime(new Date(2026, 10, 7, 9, 0));
		await r.service.flushPending();
		expect(r.vault.files.has(NOTE)).toBe(false);
		expect(r.service.waitingPaths()).toEqual([NOTE]);
		// on the class day itself the note may be made
		vi.setSystemTime(new Date(2026, 10, 4, 23, 0));
		await r.service.flushPending();
		expect(r.vault.files.has(NOTE)).toBe(true);
	});

	it("renaming or moving the notebook between two ends of the class does not duplicate the line (M11)", async () => {
		const r = rig({ [NOTE]: "# Today\n", "Moved/Analysis.notebook": "{}" }, {});
		await r.service.log(r.file, cls, snap, "doc-1");
		const moved = r.vault.vault.getFileByPath("Moved/Analysis.notebook") as never;
		await r.service.log(moved, cls, { ...snap, pages: 5 }, "doc-1");
		const lines = (r.vault.files.get(NOTE) as string).split("\n").filter((l) => l.includes("Analysis I"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("· 5 pages");
		expect(lines[0]).toContain("Moved/Analysis.notebook");
	});

	it("the vault events do not parse the waiting list again and again (M8)", async () => {
		const r = rig({}, {});
		await r.service.log(r.file, cls, snap);
		const app = r.plugin.app as { loadLocalStorage: (k: string) => unknown };
		const load = vi.fn(app.loadLocalStorage);
		app.loadLocalStorage = load;
		for (let i = 0; i < 50; i++) r.service.noteChanged(`Other/${i}.md`);
		expect(r.service.waitingPaths()).toEqual([NOTE]);
		expect(load).not.toHaveBeenCalled();
	});

	it("keeps waiting lines unwritten while the setting is off", async () => {
		const r = rig({}, {});
		await r.service.log(r.file, cls, snap);
		(r.plugin.settings as { lectureLog: boolean }).lectureLog = false;
		r.vault.put(NOTE, "n\n");
		await r.service.flushPending();
		expect(r.vault.files.get(NOTE)).toBe("n\n");
		expect(r.service.waitingPaths()).toEqual([NOTE]);
	});
});
