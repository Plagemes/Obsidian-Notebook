/**
 * Smoke check of the "Clean copy" switch in the export dialog (0.19, roadmap #239, `doc=cleanexport`, npm run harness:check): the
 * real ExportModal on the harness stand-in for Obsidian, driven with synthetic clicks. The switch is off at first; turning it on
 * shows the choice about open sticky notes; Export carries `clean` only when it is on, and a plain export carries none. It leaves
 * the dialog open with the switch on for the screenshot.
 */
import type { App } from "obsidian";
import { createPage } from "../../src/model/document";
import { PAGE_SIZES } from "../../src/model/types";
import type { ExportRequest } from "../../src/view/export";
import { ExportModal } from "../../src/view/export-dialog";
import type { CheckResult } from "./reading-check";

export interface CleanExportCheckApi {
	app: unknown;
	errors: string[];
	notices: string[];
}

let open: { root: HTMLElement; close: () => void } | null = null;

function closeDialog(): void {
	const h = open;
	open = null;
	if (!h) return;
	try {
		h.close();
	} catch {
		// Already closed.
	}
	h.root.remove();
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const shown = (el: Element | null): boolean => !!el && (el as HTMLElement).style.display !== "none" && (el as HTMLElement).getBoundingClientRect().width > 0;
const row = (root: HTMLElement, re: RegExp): HTMLElement | null =>
	[...root.querySelectorAll<HTMLElement>(".setting-item")].find((r) => re.test(r.querySelector(".setting-item-name")?.textContent ?? "")) ?? null;

function openDialog(api: CleanExportCheckApi, picked: ExportRequest[]): HTMLElement {
	closeDialog();
	const pages = [createPage(PAGE_SIZES.a4), createPage(PAGE_SIZES.a4)];
	const m = new ExportModal({
		app: api.app as App, pageCount: pages.length, pageIndex: 0, pageFirst: false, defaultFolder: "Notebooks/Demo (PNG)", canPrint: false,
		pages: () => pages, run: (request) => picked.push(request),
	});
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	open = { root, close: () => m.close() };
	return m.modalEl;
}

const exportButton = (root: HTMLElement): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === "Export");

export async function checkCleanExport(api: CleanExportCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const picked: ExportRequest[] = [];

	let root = openDialog(api, picked);
	await sleep(60);
	const sw = row(root, /^Clean copy/);
	add("the dialog offers Clean copy", shown(sw));
	add("the sticky-note choice waits for the switch", !shown(row(root, /^Also leave out open sticky notes/)));
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);

	exportButton(root)?.click();
	await sleep(50);
	add("a plain export carries no clean option", picked[0] !== undefined && picked[0].clean === undefined, JSON.stringify(picked[0]?.clean));

	root = openDialog(api, picked);
	await sleep(60);
	row(root, /^Clean copy/)?.querySelector<HTMLElement>(".checkbox-container")?.click();
	await sleep(60);
	add("the switch shows the sticky-note choice", shown(row(root, /^Also leave out open sticky notes/)));
	exportButton(root)?.click();
	await sleep(50);
	add("Export carries the clean option", picked[1]?.clean !== undefined && picked[1].clean.openStickies === false, JSON.stringify(picked[1]?.clean));

	// The picture for the review: the switch is remembered, so the dialog opens with it on.
	root = openDialog(api, picked);
	await sleep(120);
	add("the choice is remembered for the next export", shown(row(root, /^Also leave out open sticky notes/)));
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function cleanExportApi(api: CleanExportCheckApi): Record<string, unknown> {
	return {
		checkCleanExport: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkCleanExport(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`cleanexport check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		closeCleanExport: closeDialog,
	};
}
