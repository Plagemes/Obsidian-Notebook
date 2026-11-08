/**
 * Smoke check of the suggested tags (0.24, roadmap #411, `doc=tagsuggest`, npm run harness:check): the real notebook tag editor and the
 * real page tag editor show suggestion chips (course of the timetable, sibling notebooks, text, markers), one tap adds a tag, an added tag
 * leaves the chips, and the setting turns them off. The notebook editor stays open for the screenshot.
 */
import type { App } from "obsidian";
import { registerTags, TagEditorModal, type TagsHost } from "../../src/integration/tags";
import { pageSignals } from "../../src/model/tag-context";
import { PageTagsModal } from "../../src/view/outline";
import { pageTagSuggestions } from "../../src/view/tag-suggest-provider";
import { createPage } from "../../src/model/document";
import { PAGE_SIZES, type Page } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface TagSuggestCheckApi {
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
const chipsOf = (root: HTMLElement, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const labels = (els: HTMLElement[]) => els.map((e) => (e.textContent ?? "").replace(/[+×]/g, "").trim());

function demoPage(): Page {
	const p = createPage(PAGE_SIZES.a4);
	p.elements = [
		{ id: "t1", type: "text", x: 100, y: 100, width: 200, text: "Entropy and enthalpy. Entropy grows, entropy of the system.", fontSize: 16, color: "#000000" },
		{ id: "m1", type: "marker", kind: "question", x: 300, y: 300 },
		{ id: "b1", type: "box", kind: "definition", x: 80, y: 400, width: 200, height: 80, title: "Second law" },
	] as Page["elements"];
	return p;
}

function mount(m: { open(): void; close(): void; modalEl: HTMLElement }): HTMLElement {
	closeDialog();
	m.open();
	const root = document.body.createDiv({ cls: "harness-modal-container" });
	root.appendChild(m.modalEl);
	open = { root, close: () => m.close() };
	return m.modalEl;
}

export async function checkTagSuggest(api: TagSuggestCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const tt = { version: 1, entries: [{ id: "c1", course: "Thermodynamics", day: 1, start: "09:00", end: "10:00", notebook: "Uni/Physics" }] };
	const settings = { tagSuggestions: true, companionNotes: true };
	const plugin = {
		app: api.app as App, settings, timetable: { data: () => tt },
		saveSettings: () => Promise.resolve(), register: () => undefined, addCommand: () => undefined,
	} as unknown as TagsHost;
	registerTags(plugin);
	const fake = Object.assign(Object.create(api.app as object) as object, { metadataCache: { getTags: () => ({}) } }) as unknown as App;

	// Page tags: provider + real modal.
	const page = demoPage();
	const input = { path: "Uni/Physics/Week 1.notebook", page, notebookTags: ["exam"], existing: [] as string[] };
	const page6 = pageTagSuggestions(input);
	add("page suggestions: the course first, at most six", page6[0] === "Thermodynamics" && page6.length <= 6, page6.join("|"));
	add("page suggestions: text, markers and boxes are used", ["entropy", "questions", "definitions"].every((x) => page6.includes(x)), page6.join("|"));
	let saved: string[] | null = null;
	let root = mount(new PageTagsModal(fake, 1, [], [], (tags) => { saved = tags; }, (existing) => pageTagSuggestions({ ...input, existing })));
	await sleep(60);
	let chips = chipsOf(root, ".nb-tag-suggest-chip");
	add("the page editor shows the chips", chips.length > 0 && chips.length <= 6, labels(chips).join("|"));
	chips[0]?.click();
	await sleep(40);
	const field = root.querySelector<HTMLInputElement>("input[type=text]");
	add("one tap writes the tag into the field and removes its chip", field?.value === "Thermodynamics" && !labels(chipsOf(root, ".nb-tag-suggest-chip")).some((l) => l.includes("Thermodynamics")), field?.value ?? "");
	closeDialog();
	add("nothing is saved by only opening and tapping", saved === null);

	// Setting off.
	settings.tagSuggestions = false;
	add("the setting turns the page suggestions off", pageTagSuggestions(input).length === 0);
	root = mount(new TagEditorModal(fake, { file: null, current: [], context: { path: "Uni/Physics/Week 1.notebook", signals: pageSignals(page) }, onSave: () => undefined }));
	await sleep(60);
	add("the setting turns the notebook chips off", chipsOf(root, ".notebook-tags-chip-suggest").length === 0);
	closeDialog();
	settings.tagSuggestions = true;

	// Notebook editor.
	root = mount(new TagEditorModal(fake, { file: null, current: ["exam"], context: { path: "Uni/Physics/Week 1.notebook", siblings: [["lab", "exam"], ["lab"]], signals: pageSignals(page) }, onSave: () => undefined }));
	await sleep(80);
	chips = chipsOf(root, ".notebook-tags-chip-suggest");
	const names = labels(chips);
	add("the notebook editor shows the course, sibling tags and text, not tags it has", names[0] === "#Thermodynamics" && names.includes("#lab") && !names.includes("#exam") && names.length <= 6, names.join("|"));
	chips[0]?.click();
	await sleep(40);
	add("a tapped suggestion becomes a tag and leaves the chips", chipsOf(root, ".notebook-tags-chip:not(.notebook-tags-chip-suggest)").some((c) => (c.textContent ?? "").includes("#Thermodynamics")) && !labels(chipsOf(root, ".notebook-tags-chip-suggest")).includes("#Thermodynamics"));
	add("the dialog does not run sideways", root.scrollWidth <= root.clientWidth + 1, `${root.scrollWidth}/${root.clientWidth}`);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio } };
}

/** What the harness page exposes (wired in harness.ts with one line). */
export function tagSuggestApi(api: TagSuggestCheckApi): Record<string, unknown> {
	return {
		checkTagSuggest: async () => {
			try {
				return JSON.parse(JSON.stringify(await checkTagSuggest(api))) as unknown;
			} catch (e) {
				return { ok: false, results: [], errors: [`tagsuggest check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
			}
		},
		closeTagSuggest: closeDialog,
	};
}
