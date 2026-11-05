/**
 * The `notebook-new` card (0.19, review fixes M12 and M13): once the notebook exists the button never comes back, and in a note
 * template there is no button at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => [] as string[]);
const buttons = vi.hoisted(() => [] as Array<{ disabled: boolean; click: () => void }>);

vi.mock("obsidian", () => ({
	MarkdownRenderChild: class {
		constructor(public containerEl: unknown) {}
	},
	TFile: class {
		constructor(public path: string) {}
	},
	getLanguage: () => "en",
}));
vi.mock("../src/ui/components/modal-shell", () => ({
	shellButton: (_parent: unknown, _kind: string, _label: string, onClick: () => void) => {
		const b = { disabled: false, click: onClick };
		buttons.push(b);
		return b;
	},
}));
vi.mock("../src/view/notice", () => ({ showNotice: (m: string) => void shown.push(m) }));

import { TFile } from "obsidian";
import { registerNewBlock } from "../src/integration/new-block-render";

const SOURCE = 'name="Sketches"';
const NOTE = `before\n\`\`\`notebook-new\n${SOURCE}\n\`\`\`\nafter\n`;

class El {
	children: El[] = [];
	text = "";
	createDiv(o?: { text?: string }): El {
		const e = new El();
		e.text = o?.text ?? "";
		this.children.push(e);
		return e;
	}
	addClass(): void {}
	replaceChildren(...c: El[]): void {
		this.children = c;
	}
}

interface Rig {
	card: { onload(): void };
	files: Map<string, string>;
	newNotebook: ReturnType<typeof vi.fn>;
	processFails: { on: boolean };
}

function rig(sourcePath: string, folders: { core?: string } = {}): Rig {
	const files = new Map<string, string>([[sourcePath, NOTE]]);
	const note = new TFile(sourcePath);
	const processFails = { on: false };
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => (files.has(p) ? note : null),
			read: async (f: { path: string }) => files.get(f.path) ?? "",
			process: async (f: { path: string }, fn: (d: string) => string) => {
				if (processFails.on) throw new Error("disk busy");
				files.set(f.path, fn(files.get(f.path) ?? ""));
			},
		},
		internalPlugins: { getPluginById: () => (folders.core ? { enabled: true, instance: { options: { folder: folders.core } } } : null) },
	};
	const newNotebook = vi.fn(async () => ({ name: "Sketches", embed: "![[Sketches.notebook]]", link: "[[Sketches.notebook]]" }));
	let make: ((source: string, el: unknown, ctx: unknown) => void) | null = null;
	registerNewBlock({ registerMarkdownCodeBlockProcessor: (_l: string, fn: typeof make) => void (make = fn) } as never, { app: app as never, api: () => ({ newNotebook }) as never });
	let child: { onload(): void } | null = null;
	make!(SOURCE, new El(), { sourcePath, getSectionInfo: () => ({ lineStart: 1 }), addChild: (c: { onload(): void }) => void (child = c) });
	return { card: child!, files, newNotebook, processFails };
}

beforeEach(() => {
	shown.length = 0;
	buttons.length = 0;
	vi.stubGlobal("createDiv", () => new El());
});

describe("the notebook-new card", () => {
	it("makes the notebook once and replaces the block; the button stays off", async () => {
		const r = rig("Notes/Day.md");
		r.card.onload();
		expect(buttons).toHaveLength(1);
		buttons[0]!.click();
		await vi.waitFor(() => expect(shown.length).toBeGreaterThan(0));
		expect(r.files.get("Notes/Day.md")).toBe("before\n![[Sketches.notebook]]\nafter\n");
		expect(buttons[0]!.disabled).toBe(true);
	});

	it("when the note cannot be changed after the notebook was made, the button stays off and the link is shown (M12)", async () => {
		const r = rig("Notes/Day.md");
		r.card.onload();
		r.processFails.on = true;
		buttons[0]!.click();
		await vi.waitFor(() => expect(shown.length).toBeGreaterThan(0));
		expect(shown[0]).toContain("![[Sketches.notebook]]");
		expect(buttons[0]!.disabled).toBe(true);
		expect(r.newNotebook).toHaveBeenCalledTimes(1);
	});

	it("when the notebook could not be made, the button comes back", async () => {
		const r = rig("Notes/Day.md");
		r.newNotebook.mockRejectedValueOnce(new Error("no space"));
		r.card.onload();
		buttons[0]!.click();
		await vi.waitFor(() => expect(shown.length).toBeGreaterThan(0));
		expect(buttons[0]!.disabled).toBe(false);
		expect(r.files.get("Notes/Day.md")).toBe(NOTE);
	});

	it("shows no button inside a note template (M13)", () => {
		const r = rig("Templates/Class.md", { core: "Templates" });
		r.card.onload();
		expect(buttons).toHaveLength(0);
		expect(r.newNotebook).not.toHaveBeenCalled();
	});
});
