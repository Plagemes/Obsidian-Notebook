import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ getLanguage: () => "en" }));

const { toolCommands, commandName, registerToolCommands } = await import("../src/view/commands");

describe("tool commands", () => {
	it("has unique ids and a command for every tool, shape, favourite and page action", () => {
		const ids = toolCommands().map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ["tool-pen", "tool-highlighter", "tool-eraser", "tool-lasso", "tool-shape", "tool-text", "shape-line", "shape-ellipse",
			"favourite-1", "favourite-6", "pen-only", "next-page", "previous-page", "eraser-larger", "eraser-smaller"]) {
			expect(ids).toContain(id);
		}
		expect(ids.filter((i) => i.startsWith("favourite-"))).toHaveLength(6);
	});
	it("names favourites with their slot", () => {
		const fav3 = toolCommands().find((c) => c.id === "favourite-3")!;
		expect(commandName(fav3)).toBe("Favourite pen 3");
	});
	it("registers with checkCallback that only applies when a view is active", () => {
		const added: Array<{ id: string; checkCallback: (checking: boolean) => boolean }> = [];
		registerToolCommands({ addCommand: (c: never) => added.push(c) } as never, (checking, run) => {
			if (!view) return false;
			if (!checking) run(view as never);
			return true;
		});
		let view: { selectTool: (t: string) => void } | null = null;
		const picked: string[] = [];
		const pen = added.find((c) => c.id === "tool-pen")!;
		expect(pen.checkCallback(true)).toBe(false);
		view = { selectTool: (t) => picked.push(t) };
		expect(pen.checkCallback(true)).toBe(true);
		expect(picked).toEqual([]);
		pen.checkCallback(false);
		expect(picked).toEqual(["pen"]);
	});
});
