import { describe, expect, it } from "vitest";
import {
	BOARD_COLUMNS_MAX, columnIndex, columnLabel, DEFAULT_BOARD_COLUMNS, groupByStatus, isMove, newColumnId, normaliseColumns, readBoardSettings,
} from "../src/library/board-logic";
import { readSettings, DEFAULT_SETTINGS } from "../src/settings";

const cols = DEFAULT_BOARD_COLUMNS;

describe("board columns", () => {
	it("defaults to To do, In progress, Done, To print", () => {
		expect(cols.map((c) => c.id)).toEqual(["todo", "doing", "done", "print"]);
		expect(DEFAULT_SETTINGS.boardColumns.map((c) => c.id)).toEqual(["todo", "doing", "done", "print"]);
	});

	it("normalises saved columns: bad ones dropped, ids unique, colours checked, names trimmed and capped", () => {
		const out = normaliseColumns([
			{ id: "todo", name: "  Backlog  ", color: "#aabbcc" },
			{ id: "todo", name: "dup", color: "#000000" },
			{ id: "Bad Id", name: "x", color: "#000000" },
			{ id: "late", name: "N".repeat(100), color: "red" },
			"nope", null, 4,
		]);
		expect(out.map((c) => c.id)).toEqual(["todo", "late"]);
		expect(out[0]).toEqual({ id: "todo", name: "Backlog", color: "#AABBCC" });
		expect(out[1]!.name).toHaveLength(40);
		expect(out[1]!.color).toMatch(/^#[0-9A-F]{6}$/);
	});

	it("falls back to the defaults for nothing usable, and caps the count", () => {
		expect(normaliseColumns(undefined)).toEqual(DEFAULT_BOARD_COLUMNS);
		expect(normaliseColumns([])).toEqual(DEFAULT_BOARD_COLUMNS);
		expect(normaliseColumns([{ id: "A!" }])).toEqual(DEFAULT_BOARD_COLUMNS);
		const many = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: "", color: "#112233" }));
		expect(normaliseColumns(many)).toHaveLength(BOARD_COLUMNS_MAX);
	});

	it("is part of the plugin settings, read leniently", () => {
		expect(readSettings({ boardColumns: [{ id: "x1", name: "Mine", color: "#123456" }] }).boardColumns).toEqual([{ id: "x1", name: "Mine", color: "#123456" }]);
		expect(readSettings({ boardColumns: "garbage" }).boardColumns).toEqual(DEFAULT_BOARD_COLUMNS);
		expect(readBoardSettings({}).boardColumns).toEqual(DEFAULT_BOARD_COLUMNS);
	});

	it("labels: the user's name, else the translated default of a built-in id, else a generic one", () => {
		const tr = (k: string) => `T(${k})`;
		expect(columnLabel({ id: "done", name: "Finished", color: "#000000" }, tr)).toBe("Finished");
		expect(columnLabel({ id: "done", name: "", color: "#000000" }, tr)).toBe("T(board.col.done)");
		expect(columnLabel({ id: "c1", name: "", color: "#000000" }, tr)).toBe("T(board.col.new)");
	});

	it("makes new ids that are not in use", () => {
		const used = ["c00000"].map((id) => ({ id, name: "", color: "#000000" }));
		const seq = [0, 0, 0.5];
		let i = 0;
		const id = newColumnId(used, () => seq[Math.min(i++, seq.length - 1)]!);
		expect(id).not.toBe("c00000");
		expect(id).toMatch(/^[a-z0-9]{1,32}$/);
		expect(normaliseColumns([{ id, name: "", color: "#112233" }])[0]!.id).toBe(id);
	});
});

describe("board grouping", () => {
	const nb = (name: string, status: string | null) => ({ name, status });

	it("puts notebooks in the column of their status, in the order given", () => {
		const g = groupByStatus([nb("a", "done"), nb("b", "doing"), nb("c", "done"), nb("d", "print")], cols, (e) => e.status);
		expect(g.map((x) => x.entries.map((e) => e.name))).toEqual([[], ["b"], ["a", "c"], ["d"]]);
	});

	it("no status, or the status of a removed column, shows in the first column", () => {
		const g = groupByStatus([nb("a", null), nb("b", "gone")], cols.slice(1), (e) => e.status);
		expect(g[0]!.entries.map((e) => e.name)).toEqual(["a", "b"]);
		expect(columnIndex(cols, "gone")).toBe(0);
		expect(columnIndex(cols, "done")).toBe(2);
	});

	it("a column added back with the same id takes its notebooks back", () => {
		const without = cols.filter((c) => c.id !== "print");
		expect(groupByStatus([nb("a", "print")], without, (e) => e.status)[0]!.entries).toHaveLength(1);
		expect(groupByStatus([nb("a", "print")], cols, (e) => e.status)[3]!.entries).toHaveLength(1);
	});

	it("knows whether a move changes anything", () => {
		expect(isMove(cols, "done", "done")).toBe(false);
		expect(isMove(cols, null, "todo")).toBe(false);
		expect(isMove(cols, "gone", "todo")).toBe(false);
		expect(isMove(cols, "todo", "print")).toBe(true);
	});

	it("an empty column list gives no groups", () => {
		expect(groupByStatus([nb("a", null)], [], (e) => e.status)).toEqual([]);
	});
});
