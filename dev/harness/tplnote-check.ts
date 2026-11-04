/**
 * 0.19 templates (roadmap O13): the `notebook-new` card of a Markdown note on the `doc=tplnote` scenario (npm run harness:check).
 * Checked: rendering creates nothing; the card shows the name, the template and a 40 px button that fits the width; a bad block shows
 * an explanation and no button; pressing the button calls the API once and replaces only that block in the note; a block that is
 * gone makes the press do nothing but say so. The cards are left on screen for the screenshot.
 */
import { registerNewBlock } from "../../src/integration/new-block-render";
import type { NotebookApi } from "../../src/integration/api";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface TplNoteCheckApi {
	errors: string[];
	notices: string[];
}

type Processor = (source: string, el: HTMLElement, ctx: unknown) => void;

export async function checkTplNote(api: TplNoteCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();
	const block = (body: string) => `\`\`\`notebook-new\n${body}\n\`\`\``;
	const good = 'name="Optics notes"\ntemplate="Lecture"';
	const note = `# Optics\n\nBefore.\n\n${block(good)}\n\nAfter.\n`;
	const file = await app.vault.create("Optics.md", note);

	const calls: unknown[] = [];
	const fake = {
		newNotebook: async (spec: { name: string }) => {
			calls.push(spec);
			return { name: spec.name, embed: `![[${spec.name}.notebook]]` };
		},
	} as unknown as NotebookApi;
	let processor: Processor | null = null;
	const plugin = { registerMarkdownCodeBlockProcessor: (_lang: string, fn: Processor) => void (processor = fn) };
	registerNewBlock(plugin as never, { app: app as never, api: () => fake });
	add("the block language is registered", processor !== null);

	const host = (document.getElementById("harness-app") ?? document.body).createDiv({ cls: "markdown-rendered nb-tplnote-host" });
	host.setCssProps({ padding: "16px", maxWidth: "640px" });
	const mount = (source: string, line: number) => {
		const el = host.createDiv();
		const ctx = { sourcePath: "Optics.md", addChild: (c: { onload(): void }) => c.onload(), getSectionInfo: () => ({ lineStart: line, lineEnd: line + 3, text: note }) };
		processor!(source, el, ctx);
		return el;
	};
	const ok = mount(good, 4);
	const bad = mount('name="{{title}} notes"', 20);
	const button = ok.querySelector<HTMLButtonElement>("button");
	add("rendering creates nothing", calls.length === 0 && (await app.vault.read(file)) === note);
	add("the card names the notebook and the template", (ok.textContent ?? "").includes("Optics notes") && (ok.textContent ?? "").includes("Lecture"), ok.textContent ?? "");
	const box = button?.getBoundingClientRect();
	add("one Create notebook button, a 40 px target", !!button && (button.textContent ?? "").length > 0 && !!box && box.height >= 40, box ? `${Math.round(box.height)}px` : "none");
	const card = ok.querySelector<HTMLElement>(".nb-newblock")?.getBoundingClientRect();
	add("the card fits the width", !!card && card.left >= 0 && card.right <= window.innerWidth + 1);
	add("a block with unexpanded template syntax shows an explanation and no button", !bad.querySelector("button") && (bad.textContent ?? "").includes("{{title}}"), bad.textContent ?? "");

	button?.click();
	await sleep(80);
	const after = await app.vault.read(file);
	add("pressing it calls the API once with the block's fields", calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify({ name: "Optics notes", template: "Lecture" }), JSON.stringify(calls));
	add("only that block was replaced", after === note.replace(block(good), "![[Optics notes.notebook]]"), after);

	// The block is gone (edited elsewhere) before a second card is pressed: nothing is created.
	const stale = mount(good, 4);
	stale.querySelector<HTMLButtonElement>("button")?.click();
	await sleep(80);
	add("a block that is no longer in the note creates nothing", calls.length === 1 && (await app.vault.read(file)) === after);
	add("and says so", api.notices.length > 0, api.notices.join(" | "));
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
