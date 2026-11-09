// 0.27 workspaces (#375): the view side of the workspace presets. Reads which plugin panels are open around the notebook, applies a preset
// by opening or closing only those panels through their own open / close functions, and keeps the saved presets in the plugin settings.
// It never touches a document and never moves the user's other Obsidian leaves (the only leaves it closes are the plugin's own Related
// pages panels). The pure plan is in workspace-presets.ts; the picker dialog is workspace-picker.ts.
import type { App } from "obsidian";
import { t } from "../i18n";
import type { NotebookSettings } from "../settings";
import { showNotice } from "./notice";
import { RELATED_VIEW_TYPE } from "./related-view";
import { openRelatedPanel } from "./related-source";
import { WorkspacePickerModal } from "./workspace-picker";
import {
	addPreset, findPreset, isBuiltinPreset, matches, MAX_PRESETS, NARROW_SKIPPED, normaliseActivePreset, PANEL_IDS, PANEL_NAME_KEYS, planPanels, presetName,
	removePreset, renamePreset, splitOpen, updatePreset, wantedState, type PanelId, type PanelState, type WorkspacePreset,
} from "./workspace-presets";

export type NavMode = "closed" | "pages" | "outline";

/** What the tools need from the notebook view. */
export interface WorkspaceHost {
	app: App;
	settings(): NotebookSettings;
	save(): void;
	/** A phone-sized view. */
	narrow(): boolean;
	/** A notebook is open to arrange panels around. */
	available(): boolean;
	pdf: { available(): boolean; open(): boolean; pick(): void; close(): void };
	reference: { open(): boolean; pick(): void; close(): void };
	nav(): NavMode;
	setNav(mode: NavMode): void;
	/** The minimap, or null when the settings turned it off. */
	minimap(): { open: boolean; set(open: boolean): void } | null;
	/** The writing profile in use ("" none) and the switch to one. */
	profile(): string;
	applyProfile(id: string): void;
	hasProfile(id: string): boolean;
}

export class WorkspaceTools {
	constructor(private readonly host: WorkspaceHost) {}

	/** The presets the user saved. */
	custom(): WorkspacePreset[] {
		return this.host.settings().workspacePresets;
	}

	/** Which panels are open now. */
	state(): PanelState {
		const h = this.host;
		const nav = h.nav();
		return {
			pdf: h.pdf.open(),
			reference: h.reference.open(),
			navigator: nav === "pages",
			outline: nav === "outline",
			minimap: h.minimap()?.open ?? false,
			related: h.app.workspace.getLeavesOfType(RELATED_VIEW_TYPE).length > 0,
		};
	}

	/** The panels this place can show at all. */
	availablePanels(): Record<PanelId, boolean> {
		const h = this.host;
		return { pdf: h.pdf.available(), reference: true, navigator: true, outline: true, minimap: h.minimap() !== null, related: true };
	}

	/** The id of the preset that matches the arrangement in front, else "". Built-in presets win over saved ones. */
	activeId(): string {
		const s = this.host.settings();
		const id = normaliseActivePreset(s.workspacePresetActive, s.workspacePresets);
		const state = this.state(), avail = this.availablePanels();
		// A panel this screen leaves out cannot make the preset fail to hold.
		if (this.host.narrow()) for (const p of NARROW_SKIPPED) avail[p] = false;
		const p = id ? findPreset(s.workspacePresets, id) : null;
		return p && matches(p, state, avail) ? id : "";
	}

	/** Opens the picker dialog. */
	openPicker(): void {
		if (!this.host.available()) return;
		new WorkspacePickerModal(this.host.app, this).open();
	}

	/** Applies a preset: closes, then opens, the panels it differs in. */
	apply(id: string, quiet = false): boolean {
		const h = this.host;
		const s = h.settings();
		const preset = findPreset(s.workspacePresets, id);
		if (!preset || !h.available()) return false;
		const plan = planPanels(wantedState(preset), this.state(), { narrow: h.narrow(), available: this.availablePanels() });
		for (const p of plan.close) this.setPanel(p, false);
		const { now, ask, later } = splitOpen(plan.open);
		for (const p of now) this.setPanel(p, true);
		// At most one file picker per apply; the page panel's two faces never both open (the plan keeps the outline).
		if (ask) this.setPanel(ask, true);
		if (preset.profile && h.hasProfile(preset.profile)) h.applyProfile(preset.profile);
		s.workspacePresetActive = id;
		h.save();
		if (!quiet || plan.skipped.length > 0 || later.length > 0) this.notice(preset, plan.skipped, later);
		return true;
	}

	/** Opens or closes one panel through its own function. A panel that needs a file asks for it with its usual picker. */
	setPanel(panel: PanelId, on: boolean): void {
		const h = this.host;
		switch (panel) {
			case "pdf":
				if (on) h.pdf.pick();
				else h.pdf.close();
				break;
			case "reference":
				if (on) h.reference.pick();
				else h.reference.close();
				break;
			case "navigator":
				h.setNav(on ? "pages" : "closed");
				break;
			case "outline":
				h.setNav(on ? "outline" : "closed");
				break;
			case "minimap":
				h.minimap()?.set(on);
				break;
			case "related":
				if (on) void openRelatedPanel(h.app).catch((e) => console.error("[notebook] opening the related pages panel failed", e));
				else for (const leaf of h.app.workspace.getLeavesOfType(RELATED_VIEW_TYPE)) leaf.detach();
				break;
		}
	}

	private notice(preset: WorkspacePreset, skipped: readonly PanelId[], later: readonly PanelId[]): void {
		const names = (list: readonly PanelId[]): string => list.map((p) => t(PANEL_NAME_KEYS[p])).join(", ");
		let text = t("workspace.notice.applied", { name: this.nameOf(preset) });
		if (skipped.length > 0) text += ` ${t("workspace.notice.skipped", { panels: names(skipped) })}`;
		if (later.length > 0) text += ` ${t("workspace.notice.later", { panels: names(later) })}`;
		showNotice(text, skipped.length > 0 || later.length > 0 ? 6000 : 2500);
	}

	nameOf(p: WorkspacePreset): string {
		return presetName(p, (k) => t(k));
	}

	// --- saved presets ---

	canSave(): boolean {
		return this.custom().length < MAX_PRESETS;
	}

	/** Saves the arrangement in front as a new preset (with the writing profile in use) and makes it the active one; false at the limit. */
	saveCurrent(name: string): boolean {
		const s = this.host.settings();
		const profile = this.host.profile();
		const made = addPreset(s.workspacePresets, name, this.state(), profile);
		if (!made) return false;
		s.workspacePresets = made.presets;
		s.workspacePresetActive = made.id;
		this.host.save();
		return true;
	}

	/** Replaces a saved preset's panels by the arrangement in front. */
	update(id: string): void {
		const s = this.host.settings();
		if (isBuiltinPreset(id) || !s.workspacePresets.some((p) => p.id === id)) return;
		s.workspacePresets = updatePreset(s.workspacePresets, id, this.state(), this.host.profile());
		s.workspacePresetActive = id;
		this.host.save();
	}

	rename(id: string, name: string): void {
		const s = this.host.settings();
		if (isBuiltinPreset(id)) return;
		s.workspacePresets = renamePreset(s.workspacePresets, id, name);
		this.host.save();
	}

	remove(id: string): void {
		const s = this.host.settings();
		if (isBuiltinPreset(id)) return;
		s.workspacePresets = removePreset(s.workspacePresets, id);
		if (s.workspacePresetActive === id) s.workspacePresetActive = "";
		this.host.save();
	}

	/** The panels open now, in the fixed order (the picker's line for the arrangement in front). */
	openPanelIds(): PanelId[] {
		const st = this.state();
		return PANEL_IDS.filter((p) => st[p]);
	}
}
