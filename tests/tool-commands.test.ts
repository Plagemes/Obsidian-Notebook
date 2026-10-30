import { describe, expect, it, vi } from "vitest";
import mainSource from "../src/main.ts?raw";
import runnersSource from "../src/view/view-actions.ts?raw";
import { ACTIONS } from "../src/ui/actions";

vi.mock("obsidian", () => ({ getLanguage: () => "en" }));

const { commandActions, commandName, registerActionCommands } = await import("../src/view/commands");

/** Keys of an object literal written as `"id": …` in a source file. */
function quotedKeys(source: string): Set<string> {
	return new Set([...source.matchAll(/^\s*"([a-z0-9-]+)":/gm)].map((m) => m[1]!));
}

describe("commands from the action registry", () => {
	it("registers every view and global command once, with unique ids", () => {
		const ids = commandActions().map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ["tool-pen", "tool-space", "shape-ellipse", "favourite-1", "favourite-6", "pen-only", "next-page", "eraser-larger", "undo", "create", "pdf-side-link"]) {
			expect(ids).toContain(id);
		}
		expect(ids.filter((i) => i.startsWith("favourite-"))).toHaveLength(6);
		expect(ids).not.toContain("zettel-orphans");
	});

	it("names favourites with their slot and uses the command names", () => {
		const by = (id: string) => commandActions().find((c) => c.id === id)!;
		expect(commandName(by("favourite-3"))).toBe("Favourite pen 3");
		expect(commandName(by("tool-pen"))).toBe("Tool: pen");
		expect(commandName(by("pdf-side-open"))).toBe("Open PDF side by side");
	});

	it("has a runner for every view action and a handler for every global one", () => {
		const runners = quotedKeys(runnersSource);
		for (const a of ACTIONS.filter((x) => x.scope === "view")) expect(runners.has(a.id), `runner for ${a.id}`).toBe(true);
		const globals = quotedKeys(mainSource);
		for (const a of ACTIONS.filter((x) => x.scope === "global")) expect(globals.has(a.id), `handler for ${a.id}`).toBe(true);
	});

	it("registers view commands that only apply with an active view, and reports missing global handlers", () => {
		const added: Array<{ id: string; checkCallback?: (checking: boolean) => boolean; callback?: () => void }> = [];
		let view: { commandApplies: (id: string) => boolean; runAction: (id: string) => void } | null = null;
		const ran: string[] = [];
		const missing = registerActionCommands({ addCommand: (c: never) => added.push(c) } as never, {
			activeView: () => view as never,
			globals: { create: () => ran.push("create") },
		});
		expect(missing).toContain("open-library");
		expect(missing).not.toContain("create");
		added.find((c) => c.id === "create")!.callback!();
		expect(ran).toEqual(["create"]);

		const pen = added.find((c) => c.id === "tool-pen")!;
		expect(pen.checkCallback!(true)).toBe(false);
		view = { commandApplies: (id) => id !== "pdf-side-link", runAction: (id) => ran.push(id) };
		expect(pen.checkCallback!(true)).toBe(true);
		expect(ran).toEqual(["create"]);
		pen.checkCallback!(false);
		expect(ran).toEqual(["create", "tool-pen"]);
		expect(added.find((c) => c.id === "pdf-side-link")!.checkCallback!(true)).toBe(false);
	});
});
