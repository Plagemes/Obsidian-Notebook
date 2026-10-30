import { FuzzySuggestModal, Modal, Notice, Setting, type App } from "obsidian";
import { t } from "../i18n";
import { buildCustomGesture, MAX_CUSTOM_GESTURES, SAMPLES_REQUIRED, type CustomGesture } from "../ink/gestures/custom";
import type { Pt } from "../ink/gestures/geometry";
import { GESTURE_INFO, type BuiltInGestureId } from "../ink/gestures/registry";
import { looksBuiltIn } from "../ink/gestures/resolve";
import type { PenGestureSettings } from "../ink/gestures/settings";
import { commandName, listCommands, type CommandInfo } from "./obsidian-commands";

const SVG_NS = "http://www.w3.org/2000/svg";

/** What the gesture dialogs need from the plugin: the settings and a way to change them (validated by `readSettings`). */
export interface PenGestureUiHost {
	app: App;
	get(): PenGestureSettings & { penSideButton: string };
	set(key: keyof PenGestureSettings, value: unknown): Promise<void>;
}

export function gestureIcon(parent: HTMLElement, path: string, cls = "notebook-gesture-icon"): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", cls);
	svg.setAttribute("viewBox", "0 0 48 48");
	svg.setAttribute("aria-hidden", "true");
	const p = document.createElementNS(SVG_NS, "path");
	p.setAttribute("d", path);
	svg.appendChild(p);
	parent.appendChild(svg);
	return svg;
}

/** Turns a built-in gesture on or off. */
export async function setGestureEnabled(host: PenGestureUiHost, id: BuiltInGestureId, enabled: boolean): Promise<void> {
	const off = new Set(host.get().penGesturesOff);
	if (enabled) off.delete(id);
	else off.add(id);
	await host.set("penGesturesOff", [...off]);
}

/** The cheat sheet: every gesture with its drawing, what it does and a switch; the custom ones; how to start and cancel. */
export class GestureCheatSheet extends Modal {
	constructor(private readonly host: PenGestureUiHost) {
		super(host.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("notebook-gesture-sheet");
		this.setTitle(t("gesture.sheet.title"));
		contentEl.createEl("p", { cls: "notebook-gesture-sheet-intro", text: t("gesture.sheet.start") });
		const off = new Set(this.host.get().penGesturesOff);
		for (const info of GESTURE_INFO) {
			const row = contentEl.createDiv({ cls: "notebook-gesture-row" });
			gestureIcon(row, info.icon);
			const text = row.createDiv({ cls: "notebook-gesture-row-text" });
			text.createDiv({ cls: "notebook-gesture-row-name", text: t(`gesture.${info.id}.title`) });
			text.createDiv({ cls: "notebook-gesture-row-how", text: t(`gesture.${info.id}.how`) });
			new Setting(row).addToggle((toggle) => toggle
				.setValue(!off.has(info.id))
				.setTooltip(t("gesture.sheet.enabled"))
				.onChange((on) => void setGestureEnabled(this.host, info.id, on)));
		}
		const custom = this.host.get().penGesturesCustom;
		contentEl.createEl("h4", { text: t("gesture.sheet.custom") });
		if (custom.length === 0) contentEl.createEl("p", { cls: "notebook-gesture-sheet-empty", text: t("gesture.sheet.noCustom") });
		for (const g of custom) {
			const row = contentEl.createDiv({ cls: "notebook-gesture-row" });
			const svg = gestureIcon(row, pathOf(g.samples[0] ?? []));
			svg.addClass("is-custom");
			const text = row.createDiv({ cls: "notebook-gesture-row-text" });
			text.createDiv({ cls: "notebook-gesture-row-name", text: g.name });
			text.createDiv({ cls: "notebook-gesture-row-how", text: commandName(this.host.app, g.command) ?? t("gesture.custom.commandMissing", { id: g.command }) });
		}
		contentEl.createEl("p", { cls: "notebook-gesture-sheet-note", text: t("gesture.sheet.cancel") });
		contentEl.createEl("p", { cls: "notebook-gesture-sheet-note", text: t("gesture.sheet.undo") });
		new Setting(contentEl).addButton((b) => b.setButtonText(t("gesture.sheet.manage")).onClick(() => {
			this.close();
			new CustomGesturesModal(this.host).open();
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The path of a normalised sample (x, y in about -0.5..0.5) as SVG path data in the 48 x 48 icon box. */
function pathOf(sample: ReadonlyArray<readonly [number, number]>): string {
	return sample.map(([x, y], i) => `${i === 0 ? "M" : "L"}${(24 + x * 36).toFixed(1)} ${(24 + y * 36).toFixed(1)}`).join("");
}

/** The list of custom gestures: switch each one off, delete it, record a new one. */
export class CustomGesturesModal extends Modal {
	constructor(private readonly host: PenGestureUiHost) {
		super(host.app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("notebook-gesture-sheet");
		this.setTitle(t("gesture.custom.title"));
		contentEl.createEl("p", { cls: "notebook-gesture-sheet-intro", text: t("gesture.custom.intro", { n: String(SAMPLES_REQUIRED) }) });
		const list = this.host.get().penGesturesCustom;
		if (list.length === 0) contentEl.createEl("p", { cls: "notebook-gesture-sheet-empty", text: t("gesture.sheet.noCustom") });
		for (const g of list) {
			const row = contentEl.createDiv({ cls: "notebook-gesture-row" });
			gestureIcon(row, pathOf(g.samples[0] ?? [])).addClass("is-custom");
			const text = row.createDiv({ cls: "notebook-gesture-row-text" });
			text.createDiv({ cls: "notebook-gesture-row-name", text: g.name });
			text.createDiv({ cls: "notebook-gesture-row-how", text: commandName(this.app, g.command) ?? t("gesture.custom.commandMissing", { id: g.command }) });
			new Setting(row)
				.addToggle((toggle) => toggle.setValue(g.enabled).setTooltip(t("gesture.sheet.enabled")).onChange((on) => void this.update(g.id, { enabled: on })))
				.addExtraButton((b) => b.setIcon("trash-2").setTooltip(t("gesture.custom.delete")).onClick(() => void this.remove(g.id)));
		}
		new Setting(contentEl).addButton((b) => b
			.setButtonText(t("gesture.custom.new"))
			.setCta()
			.setDisabled(list.length >= MAX_CUSTOM_GESTURES)
			.onClick(() => {
				new RecordGestureModal(this.host, () => this.render()).open();
			}));
	}

	private async update(id: string, patch: Partial<CustomGesture>): Promise<void> {
		await this.host.set("penGesturesCustom", this.host.get().penGesturesCustom.map((g) => (g.id === id ? { ...g, ...patch } : g)));
	}

	private async remove(id: string): Promise<void> {
		await this.host.set("penGesturesCustom", this.host.get().penGesturesCustom.filter((g) => g.id !== id));
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class CommandPicker extends FuzzySuggestModal<CommandInfo> {
	constructor(app: App, private readonly choose: (c: CommandInfo) => void) {
		super(app);
		this.setPlaceholder(t("gesture.custom.pickCommand"));
	}

	getItems(): CommandInfo[] {
		return listCommands(this.app);
	}

	getItemText(c: CommandInfo): string {
		return c.name;
	}

	onChooseItem(c: CommandInfo): void {
		this.choose(c);
	}
}

/**
 * Records a custom gesture: a name, an Obsidian command and three samples drawn on a pad. The samples have to look alike
 * and must not look like a built-in gesture; the gesture is saved only when all three pass.
 */
export class RecordGestureModal extends Modal {
	private name = "";
	private command: CommandInfo | null = null;
	private samples: Pt[][] = [];
	private built: CustomGesture | null = null;
	private padEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private commandEl!: HTMLElement;
	private saveButton: { setDisabled(d: boolean): unknown } | null = null;
	private drawing: Pt[] | null = null;
	private svg!: SVGSVGElement;

	constructor(private readonly host: PenGestureUiHost, private readonly saved: () => void) {
		super(host.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("notebook-gesture-sheet");
		this.setTitle(t("gesture.custom.new"));
		new Setting(contentEl).setName(t("gesture.custom.name")).addText((text) => text
			.setPlaceholder(t("gesture.custom.namePlaceholder"))
			.onChange((v) => {
				this.name = v.trim();
				this.refresh();
			}));
		const cmd = new Setting(contentEl).setName(t("gesture.custom.command"));
		this.commandEl = cmd.descEl;
		this.commandEl.setText(t("gesture.custom.noCommand"));
		cmd.addButton((b) => b.setButtonText(t("gesture.custom.pickCommand")).onClick(() => {
			new CommandPicker(this.app, (c) => {
				this.command = c;
				this.commandEl.setText(c.name);
				this.refresh();
			}).open();
		}));

		this.statusEl = contentEl.createDiv({ cls: "notebook-gesture-pad-status", attr: { role: "status" } });
		this.padEl = contentEl.createDiv({ cls: "notebook-gesture-pad" });
		this.svg = document.createElementNS(SVG_NS, "svg");
		this.svg.setAttribute("class", "notebook-gesture-pad-svg");
		this.padEl.appendChild(this.svg);
		this.padEl.addEventListener("pointerdown", (e) => this.down(e));
		this.padEl.addEventListener("pointermove", (e) => this.move(e));
		this.padEl.addEventListener("pointerup", (e) => this.up(e));
		this.padEl.addEventListener("pointercancel", () => this.cancel());

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("gesture.custom.clear")).onClick(() => {
				this.samples = [];
				this.built = null;
				this.paint();
				this.refresh();
			}))
			.addButton((b) => {
				b.setButtonText(t("gesture.custom.save")).setCta().setDisabled(true).onClick(() => void this.save());
				this.saveButton = b;
			});
		this.paint();
		this.refresh();
	}

	private point(e: PointerEvent): Pt {
		const r = this.padEl.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private down(e: PointerEvent): void {
		if (this.samples.length >= SAMPLES_REQUIRED) return;
		e.preventDefault();
		this.padEl.setPointerCapture?.(e.pointerId);
		this.drawing = [this.point(e)];
		this.paint();
	}

	private move(e: PointerEvent): void {
		if (!this.drawing) return;
		this.drawing.push(this.point(e));
		this.paint();
	}

	private up(e: PointerEvent): void {
		const stroke = this.drawing;
		this.drawing = null;
		if (!stroke) return;
		this.padEl.releasePointerCapture?.(e.pointerId);
		this.samples.push(stroke);
		if (this.samples.length === SAMPLES_REQUIRED) this.finish();
		this.paint();
		this.refresh();
	}

	private cancel(): void {
		this.drawing = null;
		this.paint();
	}

	/** All samples are in: build the gesture or say why not and start the samples again. */
	private finish(): void {
		const r = buildCustomGesture(`g${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, this.name || t("gesture.customUnnamed"), this.command?.id ?? "", this.samples, looksBuiltIn);
		if ("gesture" in r) {
			this.built = r.gesture;
			return;
		}
		this.built = null;
		this.samples = [];
		new Notice(t(`gesture.custom.error.${r.error}`));
	}

	private paint(): void {
		this.svg.replaceChildren();
		const draw = (pts: readonly Pt[], cls: string): void => {
			const line = document.createElementNS(SVG_NS, "polyline");
			line.setAttribute("class", cls);
			line.setAttribute("points", pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
			this.svg.appendChild(line);
		};
		for (const s of this.samples) draw(s, "notebook-gesture-pad-sample");
		if (this.drawing) draw(this.drawing, "notebook-gesture-trail");
	}

	private refresh(): void {
		const left = SAMPLES_REQUIRED - this.samples.length;
		this.statusEl.setText(left > 0 ? t("gesture.custom.draw", { n: String(this.samples.length + 1), total: String(SAMPLES_REQUIRED) }) : t("gesture.custom.ready"));
		this.saveButton?.setDisabled(!(this.built && this.name && this.command));
	}

	private async save(): Promise<void> {
		const g = this.built;
		if (!g || !this.command || !this.name) return;
		const list = this.host.get().penGesturesCustom;
		if (list.length >= MAX_CUSTOM_GESTURES) {
			new Notice(t("gesture.custom.limit", { n: String(MAX_CUSTOM_GESTURES) }));
			return;
		}
		await this.host.set("penGesturesCustom", [...list, { ...g, name: this.name, command: this.command.id }]);
		this.saved();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** A toolbar-sized icon for the mode entry; kept here so the entry and the badge agree. */
export const PEN_GESTURE_ICON = "wand-2";
