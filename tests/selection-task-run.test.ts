/**
 * 0.17 review fixes (F7): runMakeTask on an in-memory vault. The task's picture is kept only when the line got into the note: an
 * append that fails, or a line that is already there, sends the picture just stored to the trash.
 */
import { describe, expect, it, vi } from "vitest";
import { createPage } from "../src/model/document";
import { FakeVault } from "./fake-vault";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());
const draw = vi.hoisted(() => ({ picture: true }));
vi.mock("../src/view/page-images", () => ({
	PageImageRenderer: class {
		async renderRegions(): Promise<{ blobs: Blob[] }> {
			return { blobs: draw.picture ? [new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })] : [] };
		}
		close(): void {}
	},
}));

const { runMakeTask } = await import("../src/view/selection-task");
const { Notice } = (await import("obsidian")) as unknown as { Notice: { shown: string[] } };

interface Rig {
	vault: FakeVault;
	binaries: Map<string, number>;
	trashed: string[];
	host: Parameters<typeof runMakeTask>[0];
}

function rig(notes: Record<string, string>, opts: { failProcess?: boolean } = {}): Rig {
	const vault = new FakeVault(notes);
	vault.put("Notebooks/Maths.notebook", "{}");
	const binaries = new Map<string, number>();
	const trashed: string[] = [];
	const files = vault.vault as unknown as Record<string, unknown>;
	files.createBinary = async (path: string, data: ArrayBuffer) => {
		binaries.set(path, data.byteLength);
		vault.put(path, "<png>");
		return vault.vault.getFileByPath(path);
	};
	if (opts.failProcess) {
		files.process = async () => {
			throw new Error("note is locked");
		};
	}
	const store = new Map<string, unknown>();
	const app = {
		vault: vault.vault,
		fileManager: {
			getAvailablePathForAttachment: async (name: string) => `Attachments/${name}`,
			generateMarkdownLink: (file: { path: string }, _from: string, sub?: string, alias?: string) => `[[${file.path}${sub ?? ""}${alias ? `|${alias}` : ""}]]`,
			trashFile: async (f: { path: string }) => {
				trashed.push(f.path);
				vault.files.delete(f.path);
				binaries.delete(f.path);
			},
		},
		loadLocalStorage: (k: string) => store.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => void store.set(k, v),
	};
	const host = {
		app: app as never, file: vault.vault.getFileByPath("Notebooks/Maths.notebook") as never,
		settings: { taskDueEmoji: true, tasksNote: "", dailyCreateNote: false, folder: "Notebooks" } as never,
		page: createPage({ width: 595, height: 842 }, { kind: "blank", spacing: 0 }), pageNumber: 3,
		crop: { x: 0, y: 0, width: 100, height: 100 }, media: null, render: {},
	};
	return { vault, binaries, trashed, host };
}

const NOW = new Date(2026, 10, 4, 9, 30, 15);
const note = (r: Rig, path: string) => r.vault.vault.getFileByPath(path) as never;

describe("F7: the task picture and the note stay in step", () => {
	it("a task is added with its picture", async () => {
		const r = rig({ "Notes/Inbox.md": "# Inbox" });
		const path = await runMakeTask(r.host, { text: "Check", due: "", target: { kind: "file", file: note(r, "Notes/Inbox.md") } }, NOW);
		expect(path).toBe("Notes/Inbox.md");
		expect([...r.binaries.keys()]).toEqual(["Attachments/Maths task p3-093015.png"]);
		expect(r.vault.files.get("Notes/Inbox.md")).toContain("![[Attachments/Maths task p3-093015.png|200]]");
		expect(r.trashed).toEqual([]);
	});

	it("an append that fails sends the stored picture to the trash and leaves no orphan", async () => {
		const r = rig({ "Notes/Inbox.md": "# Inbox" }, { failProcess: true });
		const path = await runMakeTask(r.host, { text: "Check", due: "", target: { kind: "file", file: note(r, "Notes/Inbox.md") } }, NOW);
		expect(path).toBeNull();
		expect(r.trashed).toEqual(["Attachments/Maths task p3-093015.png"]);
		expect(r.binaries.size).toBe(0);
		expect(r.vault.files.get("Notes/Inbox.md")).toBe("# Inbox");
		expect(Notice.shown[Notice.shown.length - 1]).toContain("note is locked");
	});

	it("a line that is already in the note says so instead of done", async () => {
		draw.picture = false;
		try {
			const r = rig({ "Notes/Inbox.md": "# Inbox" });
			const request = { text: "Same", due: "", target: { kind: "file" as const, file: note(r, "Notes/Inbox.md") } };
			await runMakeTask(r.host, request, NOW);
			const once = r.vault.files.get("Notes/Inbox.md");
			expect(Notice.shown[Notice.shown.length - 1]).toContain("added to");
			const path = await runMakeTask(r.host, request, NOW);
			expect(path).toBe("Notes/Inbox.md");
			expect(r.vault.files.get("Notes/Inbox.md")).toBe(once);
			expect(Notice.shown[Notice.shown.length - 1]).toContain("already in");
		} finally {
			draw.picture = true;
		}
	});

	it("a duplicate that came with a picture sends the picture to the trash", async () => {
		const r = rig({ "Notes/Inbox.md": "# Inbox" });
		// the note already holds the very line the run is going to build (picture name and all)
		const first = await runMakeTask(r.host, { text: "Same", due: "", target: { kind: "file", file: note(r, "Notes/Inbox.md") } }, NOW);
		expect(first).toBe("Notes/Inbox.md");
		r.vault.files.delete("Attachments/Maths task p3-093015.png");
		r.binaries.clear();
		const again = await runMakeTask(r.host, { text: "Same", due: "", target: { kind: "file", file: note(r, "Notes/Inbox.md") } }, NOW);
		expect(again).toBe("Notes/Inbox.md");
		expect(r.trashed).toEqual(["Attachments/Maths task p3-093015.png"]);
		expect(r.vault.files.get("Notes/Inbox.md")!.match(/Same/g)).toHaveLength(1);
		expect(Notice.shown[Notice.shown.length - 1]).toContain("already in");
	});
});
