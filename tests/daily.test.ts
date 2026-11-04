import { describe, expect, it } from "vitest";
import {
	dailyNotebookPath, dailyNotePath, defaultDailyPath, findDatedPage, parseDailyConfig, withTodayLink,
} from "../src/library/daily-logic";
import { createDocument } from "../src/model/document";
import { parse, serializeChecked } from "../src/model/serialize";
import { History, AddPage } from "../src/model/history";
import { buildLecturePage, isoDate } from "../src/view/lecture-logic";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";

const today = new Date(2026, 10, 4, 9, 30);
const yesterday = new Date(2026, 10, 3, 22, 0);
const fmt = (d: Date, pattern: string): string => (pattern === "YYYY-MM-DD" ? isoDate(d) : pattern === "YYYY/MM/YYYY-MM-DD" ? `${d.getFullYear()}/${isoDate(d)}` : pattern);

describe("daily notebook path", () => {
	it("defaults to Daily.notebook in the notebooks folder", () => {
		expect(defaultDailyPath("Notebooks")).toBe("Notebooks/Daily.notebook");
		expect(dailyNotebookPath("Notebooks", "")).toBe("Notebooks/Daily.notebook");
		expect(dailyNotebookPath("/Notebooks/", "   ")).toBe("Notebooks/Daily.notebook");
	});

	it("uses the chosen path, made safe, and never the quick-notes fallback", () => {
		expect(dailyNotebookPath("Notebooks", "Journal/Days")).toBe("Journal/Days.notebook");
		expect(dailyNotebookPath("Notebooks", "../..")).toBe("Notebooks/Daily.notebook");
		expect(dailyNotebookPath("Notebooks", "Notebooks/_assets/x")).toBe("Notebooks/Daily.notebook");
	});
});

describe("finding today's page", () => {
	it("finds the page by its dated header, not by position", () => {
		const doc = createDocument(today);
		doc.pages = [buildLecturePage(undefined, "", yesterday), buildLecturePage(undefined, "", today), buildLecturePage(undefined, "", yesterday)];
		expect(findDatedPage(doc.pages, today)).toBe(1);
		expect(findDatedPage(doc.pages, yesterday)).toBe(0);
		expect(findDatedPage(doc.pages, new Date(2026, 10, 5))).toBe(-1);
	});

	it("accepts a lecture-style '<title> — <date>' header and ignores a date only mentioned in text", () => {
		const titled = buildLecturePage(undefined, "Physics", today);
		expect(findDatedPage([titled], today)).toBe(0);
		const mention = buildLecturePage(undefined, "", today);
		mention.elements = [{ ...mention.elements![0]!, text: `Remember the exam on ${isoDate(today)}` } as never];
		expect(findDatedPage([mention], today)).toBe(-1);
		expect(findDatedPage([{ }], today)).toBe(-1);
	});

	it("adds the page once: a second run finds it", () => {
		const doc = createDocument(today);
		const history = new History(() => doc);
		const run = (): number => {
			let index = findDatedPage(doc.pages, today);
			if (index < 0) {
				history.execute(new AddPage(buildLecturePage(doc.pages[doc.pages.length - 1], "", today), doc.pages.length));
				index = findDatedPage(doc.pages, today);
			}
			return index;
		};
		expect(run()).toBe(1);
		expect(run()).toBe(1);
		expect(doc.pages).toHaveLength(2);
	});

	it("keeps the document valid with the new page", () => {
		const doc = createDocument(today);
		doc.pages.push(buildLecturePage(doc.pages[0], "", today));
		const checked = serializeChecked(doc);
		expect(checked.ok).toBe(true);
		const back = checked.ok ? parse(checked.text) : null;
		expect(back && back.ok ? findDatedPage(back.doc.pages, today) : -2).toBe(1);
	});
});

describe("daily note settings and path", () => {
	it("reads the options leniently", () => {
		expect(parseDailyConfig({ folder: "/Daily/", format: " YYYY-MM-DD " })).toEqual({ folder: "Daily", format: "YYYY-MM-DD" });
		expect(parseDailyConfig({ folder: 3, format: "" })).toEqual({ folder: "", format: "YYYY-MM-DD" });
		expect(parseDailyConfig({})).toEqual({ folder: "", format: "YYYY-MM-DD" });
		expect(parseDailyConfig(null)).toBeNull();
		expect(parseDailyConfig("x")).toBeNull();
	});

	it("builds the path of the day's note", () => {
		expect(dailyNotePath({ folder: "Daily", format: "YYYY-MM-DD" }, today, fmt)).toBe("Daily/2026-11-04.md");
		expect(dailyNotePath({ folder: "", format: "YYYY-MM-DD" }, today, fmt)).toBe("2026-11-04.md");
		expect(dailyNotePath({ folder: "J", format: "YYYY/MM/YYYY-MM-DD" }, today, fmt)).toBe("J/2026/2026-11-04.md");
	});
});

describe("linking from the daily note", () => {
	const id = "p-abc123";
	const line = `[[Daily.notebook#p2&id=${id}|Handwritten page 2026-11-04]]`;

	it("appends the link and leaves the rest of the note exactly as it was", () => {
		const note = "# 2026-11-04\r\n\r\n- call mum\r\n- [ ] buy milk";
		const out = withTodayLink(note, line, id);
		expect(out).toBe(`${note}\r\n${line}\r\n`);
		expect(out?.startsWith(note)).toBe(true);
	});

	it("does not add a blank line when the note already ends with a newline, and fills an empty note", () => {
		expect(withTodayLink("hello\n", line, id)).toBe(`hello\n${line}\n`);
		expect(withTodayLink("", line, id)).toBe(`${line}\n`);
	});

	it("is idempotent: the page id or the very line already in the note means no write", () => {
		const once = withTodayLink("notes\n", line, id) ?? "";
		expect(withTodayLink(once, line, id)).toBeNull();
		expect(withTodayLink(`see [[Other.notebook#p9&id=${id}]] here`, line, id)).toBeNull();
		expect(withTodayLink(`before\n  ${line}  \nafter`, line, "")).toBeNull();
	});

	it("a different page is still added", () => {
		const once = withTodayLink("notes\n", line, id) ?? "";
		expect(withTodayLink(once, "[[Daily.notebook#p3&id=p-zzz999]]", "p-zzz999")).toContain("p-zzz999");
	});
});

describe("settings", () => {
	it("has the daily options off by default and reads them leniently", () => {
		expect(DEFAULT_SETTINGS.dailyLink).toBe(false);
		expect(DEFAULT_SETTINGS.dailyCreateNote).toBe(false);
		expect(DEFAULT_SETTINGS.dailyNotebookPath).toBe("");
		const s = readSettings({ dailyLink: true, dailyCreateNote: "yes", dailyNotebookPath: "  Journal/Days  " });
		expect(s.dailyLink).toBe(true);
		expect(s.dailyCreateNote).toBe(false);
		expect(s.dailyNotebookPath).toBe("Journal/Days");
	});
});
