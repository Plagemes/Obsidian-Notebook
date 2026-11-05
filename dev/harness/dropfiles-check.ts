/**
 * Smoke check of files dropped on a page (0.20, roadmap #79; `doc=dropfiles`, npm run harness:check): the real view with real
 * DragEvents. The drop indicator follows the drag (and is not shown for text), two pictures land in a cascade as one undo step,
 * a file of another type is named in one notice, a locked page refuses the drop, and a PDF asks what it should become.
 * `dropShot(state)` leaves one state up for the screenshots.
 */
import type { Page } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface DropCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface DropView extends HarnessView {
	setPageLocked(page: Page, value: boolean): boolean;
	currentPage(): number;
	undo(): void;
}

export const DROP_STATES = ["over", "blocked", "pdf", "placed"] as const;
export type DropState = typeof DROP_STATES[number];

const stage = (): HTMLElement => document.querySelector<HTMLElement>(".notebook-stage")!;
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function png(color: string, w = 160, h = 100): Promise<File> {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const ctx = c.getContext("2d")!;
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, w, h);
	const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), "image/png"));
	return new File([blob], `${color.replace("#", "")}.png`, { type: "image/png" });
}

function dragEvent(type: "dragenter" | "dragover" | "drop", files: File[], x: number, y: number): DragEvent {
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	return new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true });
}

function aim(): [number, number] {
	const r = stage().getBoundingClientRect();
	return [r.left + r.width / 2, r.top + r.height / 3];
}

const fakePdf = (name: string) => new File([new TextEncoder().encode("%PDF-1.4\n")], name, { type: "application/pdf" });

/** A hold that keeps sending dragover so the indicator stays up for a screenshot. */
let holdTimer: number | null = null;
function release(): void {
	if (holdTimer !== null) window.clearInterval(holdTimer);
	holdTimer = null;
	// Cancel the PDF question the way a user would, so the drop in progress ends.
	document.querySelectorAll<HTMLElement>(".nb-drop-pdf .nb-modal-foot button").forEach((b) => b.click());
}

export async function checkDropFiles(api: DropCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as DropView;
	const frames = api.frames;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const images = () => (page().elements ?? []).filter((e) => e.type === "image");
	const zone = () => document.querySelector<HTMLElement>(".nb-drop-zone");
	const [x, y] = aim();

	// --- the indicator ---
	const over = dragEvent("dragover", [await png("#3366cc")], x, y);
	stage().dispatchEvent(over);
	add("a drag with files shows the drop frame and takes the drop", zone()?.classList.contains("is-active") && over.defaultPrevented, zone()?.className ?? "none");
	add("the frame names the page it would land on", /1/.test(zone()?.querySelector(".nb-drop-chip-text")?.textContent ?? ""), zone()?.querySelector(".nb-drop-chip-text")?.textContent ?? "");
	await sleep(600);
	add("the frame goes away by itself when the drag stops", !zone()?.classList.contains("is-active"));
	const textDrag = new DragEvent("dragover", { dataTransfer: new DataTransfer(), clientX: x, clientY: y, bubbles: true, cancelable: true });
	stage().dispatchEvent(textDrag);
	add("a drag without files is left alone", !textDrag.defaultPrevented && !zone()?.classList.contains("is-active"));

	// --- two pictures and a stranger ---
	const before = images().length;
	api.notices.length = 0;
	const a = await png("#cc3333");
	const b = await png("#33aa55", 100, 160);
	const zip = new File([new Uint8Array([80, 75, 3, 4])], "x.zip", { type: "application/zip" });
	stage().dispatchEvent(dragEvent("drop", [a, b, zip], x, y));
	for (let i = 0; i < 40 && images().length < before + 2; i++) await sleep(100);
	await frames(2);
	const placed = images().slice(before) as unknown as Array<{ x: number; y: number; width: number; height: number }>;
	add("two pictures were placed as image elements", placed.length === 2, `${placed.length}`);
	add("they are in a cascade (the second a step down and right)", placed.length === 2 && placed[1]!.x > placed[0]!.x && placed[1]!.y > placed[0]!.y, JSON.stringify(placed));
	add("they are inside the page", placed.every((p) => p.x >= 0 && p.y >= 0 && p.x + p.width <= page().width + 0.01 && p.y + p.height <= page().height + 0.01));
	add("the zip is named in one notice", api.notices.filter((n) => /Not added/.test(n)).length === 1, api.notices.join(" | "));
	v.undo();
	await frames(2);
	add("one undo takes both pictures away", images().length === before, `${images().length - before} left`);

	// --- lock ---
	v.setPageLocked(page(), true);
	await frames(2);
	stage().dispatchEvent(dragEvent("dragover", [a], x, y));
	await frames(2);
	add("a locked page shows the blocked frame", zone()?.classList.contains("is-blocked") === true);
	api.notices.length = 0;
	stage().dispatchEvent(dragEvent("drop", [a], x, y));
	await sleep(500);
	add("a locked page takes nothing and says so", images().length === before && api.notices.some((n) => /locked/i.test(n)), api.notices.join(" | "));
	v.setPageLocked(page(), false);
	await sleep(600);

	// --- a PDF asks ---
	stage().dispatchEvent(dragEvent("drop", [fakePdf("slides.pdf")], x, y));
	for (let i = 0; i < 30 && !document.querySelector(".nb-drop-pdf"); i++) await sleep(100);
	const rows = [...document.querySelectorAll(".nb-drop-pdf .nb-modal-row")].map((r) => r.textContent ?? "");
	add("a PDF offers pages and pictures (and a notebook of its own when the plugin can)", rows.length >= 2 && /pages after/i.test(rows[0]!) && /images on this page/i.test(rows[1]!), rows.join(" | "));
	release();
	await sleep(200);

	// --- the page that stays for the screenshot ---
	stage().dispatchEvent(dragEvent("drop", [await png("#cc8833"), await png("#7744bb", 120, 120), await png("#228899", 90, 140)], x, y));
	for (let i = 0; i < 40 && images().length < before + 3; i++) await sleep(100);
	await frames(3);
	add("three pictures stay on the page", images().length === before + 3, `${images().length - before}`);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { images: images().length } };
}

/** Leaves one state up for a screenshot (`dropRelease` takes it down). */
export async function dropShot(api: DropCheckApi, state: DropState): Promise<void> {
	const v = api.view as DropView;
	release();
	await sleep(300);
	const [x, y] = aim();
	const hold = (files: File[]) => {
		const send = () => stage().dispatchEvent(dragEvent("dragover", files, x, y));
		send();
		holdTimer = window.setInterval(send, 150);
	};
	v.setPageLocked(page0(v), false);
	if (state === "over") hold([await png("#3366cc")]);
	if (state === "blocked") {
		v.setPageLocked(page0(v), true);
		hold([await png("#3366cc")]);
	}
	if (state === "pdf") {
		stage().dispatchEvent(dragEvent("drop", [fakePdf("lecture-notes.pdf")], x, y));
		for (let i = 0; i < 30 && !document.querySelector(".nb-drop-pdf"); i++) await sleep(100);
	}
	await api.frames(3);
}

const page0 = (v: DropView): Page => v.document.pages[v.currentPage()]!;

export function dropApi(api: DropCheckApi): Record<string, unknown> {
	return {
		dropStates: DROP_STATES,
		checkDropFiles: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkDropFiles(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`dropfiles check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		dropShot: (state: DropState) => dropShot(api, state),
		dropRelease: () => {
			release();
			const v = api.view as DropView;
			v.setPageLocked(page0(v), false);
		},
	};
}
