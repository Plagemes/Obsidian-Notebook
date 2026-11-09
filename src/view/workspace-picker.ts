// 0.27 workspaces (#375): the picker of the workspace presets, a dialog on the shared modal shell. One tile per preset (Lecture, Study,
// Focus, then the user's own) with the panels it opens; a tap applies it and closes the dialog. The user's own presets can be renamed
// and deleted; "Save current arrangement" keeps the panels open now as a new preset. Behaviour is in workspace-tools.ts.
import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { PromptModal } from "../library/library-modals";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { showNotice } from "./notice";
import type { WorkspaceTools } from "./workspace-tools";
import {
	allPresets, BUILTIN_PRESET_ICONS, cleanPresetName, isBuiltinPreset, MAX_PRESETS, PANEL_NAME_KEYS, presetName, wantedState,
	type PanelId, type WorkspacePreset,
} from "./workspace-presets";

export class WorkspacePickerModal extends Modal {
	constructor(app: App, private readonly tools: WorkspaceTools) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	private panelsLine(list: readonly PanelId[]): string {
		return list.length === 0 ? t("workspace.noPanels") : list.map((p) => t(PANEL_NAME_KEYS[p])).join(" · ");
	}

	private render(): void {
		const shell = modalShell(this, { title: t("workspace.title"), subtitle: t("workspace.subtitle"), icon: "layout-dashboard", size: "narrow", cls: "nb-ws-modal" });
		const active = this.tools.activeId();
		const list = shell.body.createDiv({ cls: "nb-ws-list", attr: { role: "list", "aria-label": t("workspace.title") } });
		for (const p of allPresets(this.tools.custom())) this.renderRow(list, p, p.id === active);
		shellNote(shell.body, t("workspace.now", { panels: this.panelsLine(this.tools.openPanelIds()) }));
		shellNote(shell.body, t("workspace.hint"));
		shellButton(shell.foot, "secondary", t("histpanel.close"), () => this.close());
		shellButton(shell.foot, "primary", t("workspace.saveAs"), () => this.saveCurrent(), { icon: "plus", disabled: !this.tools.canSave() });
	}

	private renderRow(list: HTMLElement, p: WorkspacePreset, current: boolean): void {
		const name = presetName(p, (k) => t(k));
		const row = list.createDiv({ cls: `nb-ws-row${current ? " is-current" : ""}`, attr: { role: "listitem" } });
		const main = row.createEl("button", {
			cls: "nb-ws-row-btn",
			attr: { type: "button", "aria-label": t("workspace.apply.aria", { name }), ...(current ? { "aria-current": "true" } : {}) },
		});
		setIcon(main.createSpan({ cls: "nb-ws-row-icon", attr: { "aria-hidden": "true" } }), isBuiltinPreset(p.id) ? BUILTIN_PRESET_ICONS[p.id] : "layout-dashboard");
		const text = main.createSpan({ cls: "nb-ws-row-text" });
		text.createSpan({ cls: "nb-ws-row-title", text: name });
		const want = wantedState(p);
		text.createSpan({ cls: "nb-ws-row-detail", text: this.panelsLine((Object.keys(want) as PanelId[]).filter((k) => want[k])) });
		if (current) main.createSpan({ cls: "nb-ws-now", text: t("workspace.active") });
		main.addEventListener("click", () => {
			this.close();
			this.tools.apply(p.id);
		});
		if (isBuiltinPreset(p.id)) return;
		const actions = row.createDiv({ cls: "nb-ws-row-actions" });
		this.rowButton(actions, "refresh-cw", t("workspace.update", { name }), () => {
			this.tools.update(p.id);
			showNotice(t("workspace.updated", { name }));
			this.render();
		});
		this.rowButton(actions, "pencil", t("workspace.rename", { name }), () => {
			new PromptModal(this.app, { title: t("workspace.rename", { name }), label: t("workspace.name.label"), value: p.name, cta: t("workspace.name.cta") }, (value) => {
				if (!cleanPresetName(value)) return;
				this.tools.rename(p.id, value);
				this.render();
			}).open();
		});
		this.rowButton(actions, "trash", t("workspace.delete", { name }), () => {
			this.tools.remove(p.id);
			showNotice(t("workspace.deleted", { name }));
			this.render();
		});
	}

	private rowButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const b = parent.createEl("button", { cls: "nb-ws-icon-btn", attr: { type: "button", "aria-label": label, title: label } });
		setIcon(b, icon);
		b.addEventListener("click", onClick);
	}

	private saveCurrent(): void {
		if (!this.tools.canSave()) {
			showNotice(t("workspace.limit", { n: String(MAX_PRESETS) }));
			return;
		}
		new PromptModal(this.app, { title: t("workspace.saveAs"), label: t("workspace.name.label"), cta: t("workspace.name.cta") }, (value) => {
			if (!cleanPresetName(value)) return;
			if (!this.tools.saveCurrent(value)) {
				showNotice(t("workspace.limit", { n: String(MAX_PRESETS) }));
				return;
			}
			showNotice(t("workspace.created", { name: cleanPresetName(value) }));
			this.render();
		}).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
