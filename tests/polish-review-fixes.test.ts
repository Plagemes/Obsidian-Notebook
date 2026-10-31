import { beforeEach, describe, expect, it, vi } from "vitest";

const created: string[] = [];
vi.mock("obsidian", () => ({ normalizePath: (p: string) => p, getLanguage: () => "en" }));
vi.mock("../src/integration/open", () => ({ openNotebookAtPage: vi.fn(), viewsOf: () => [] }));
vi.mock("../src/storage/vault-io", () => ({ ensureFolder: async () => undefined }));
vi.mock("../src/view/notice", () => ({ showNotice: () => undefined }));
vi.mock("../src/storage/notebooks", () => ({
	createNotebook: async (_app: unknown, _folder: string, base: string) => {
		await sleep(10);
		created.push(base);
		return { path: `${base}.notebook` };
	},
}));

import { sleep } from "./node-env";
import { openLooseSheet, openNewQuickPage } from "../src/library/loose-sheet";
import { DEFAULT_SETTINGS } from "../src/settings";
import { WritingGuard } from "../src/ink/writing-guard";

describe("loose sheet: one creation for every entry point", () => {
	beforeEach(() => {
		created.length = 0;
	});
	it("the Home card and the ribbon used at once make Quick notes once", async () => {
		const files = new Map<string, unknown>();
		const app = {
			vault: {
				getFileByPath: (p: string) => files.get(p) ?? null,
				getAbstractFileByPath: (p: string) => files.get(p) ?? null,
			},
		};
		const plugin = { app, settings: { ...DEFAULT_SETTINGS } } as never;
		const open = async () => undefined;
		await Promise.all([openLooseSheet(plugin, open), openNewQuickPage(plugin, open)]);
		expect(created).toHaveLength(1);
	});
});

describe("writing quiet scheduler (the activity save)", () => {
	it("a task waits while the pen is down and runs once, with its key replaced", () => {
		let t = 0;
		const pending: Array<() => void> = [];
		const guard = new WritingGuard(() => t, { set: (fn) => { pending.push(fn); return 1; }, clear: () => { pending.length = 0; } });
		guard.penDown(1);
		const ran: number[] = [];
		guard.whenQuiet(() => ran.push(1), "recent-activity");
		guard.whenQuiet(() => ran.push(2), "recent-activity");
		expect(ran).toEqual([]);
		guard.penUp(1);
		t += 5000;
		pending[pending.length - 1]?.();
		expect(ran).toEqual([2]);
	});
});
