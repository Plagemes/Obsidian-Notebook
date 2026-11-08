import { Menu, Notice, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { PromptModal } from "../library/library-modals";
import { allProfiles, cleanProfileName, isBuiltin, MAX_PROFILES, profileName, type WritingProfile } from "./writing-profiles";

/** What the switcher needs from the notebook view. */
export interface ProfileHost {
	app: App;
	/** The user's own profiles (the built-in ones are always there). */
	custom(): WritingProfile[];
	/** The profile in use as the chip shows it (null: none, or the settings were changed since). */
	active(): WritingProfile | null;
	/** Switches to a profile. */
	apply(id: string): void;
	/** Saves the current pens, smoothing and paper as a new profile and makes it the active one; false when the limit is reached. */
	saveAs(name: string): boolean;
	update(id: string): void;
	/** Deletes a profile and the pen set it made; true when that set was kept because a notebook, a folder or another profile still uses it. */
	remove(id: string): boolean;
	/** The chip is disabled while nothing is open. */
	available(): boolean;
}

/**
 * The writing profile switcher: a chip on the pen options row ("Profile: Lecture") that opens a menu to pick Lecture, Study or one
 * of the user's own, save the current setup as a new profile, update or delete an own one. Switching only changes tools and
 * defaults (pens, smoothing, paper of new notebooks): it never touches a stroke or a page (see writing-profiles.ts).
 */
export class ProfileControls {
	private readonly button: HTMLButtonElement;
	private readonly label: HTMLElement;

	constructor(parent: HTMLElement, private readonly host: ProfileHost) {
		this.button = parent.createEl("button", { cls: "nb-ui notebook-penset-chip notebook-profile-chip", attr: { type: "button", "aria-haspopup": "menu" } });
		this.button.dataset.help = "help.profileChip";
		setIcon(this.button.createSpan({ cls: "notebook-penset-icon", attr: { "aria-hidden": "true" } }), "zap");
		this.label = this.button.createSpan({ cls: "notebook-penset-label" });
		setIcon(this.button.createSpan({ cls: "notebook-penset-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
		this.button.addEventListener("click", (e) => {
			e.preventDefault();
			this.openMenu();
		});
		this.refresh();
	}

	/** Redraws the chip for the active profile. Cheap. */
	refresh(): void {
		const a = this.host.active();
		const name = a ? profileName(a, (k) => t(k)) : t("profiles.none");
		this.label.setText(name);
		this.button.toggleClass("is-active", a !== null);
		this.button.setAttribute("aria-label", `${t("profiles.chip")}: ${name}`);
		this.button.disabled = !this.host.available();
	}

	private openMenu(): void {
		const custom = this.host.custom();
		const active = this.host.active();
		const menu = new Menu();
		for (const p of allProfiles(custom)) {
			const name = profileName(p, (k) => t(k));
			menu.addItem((i) => i.setTitle(name).setIcon(isBuiltin(p.id) ? (p.id === "lecture" ? "zap" : "graduation-cap") : "user").setChecked(active?.id === p.id).onClick(() => this.pick(p.id)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t("profiles.saveAs")).setIcon("plus").setDisabled(custom.length >= MAX_PROFILES).onClick(() => this.saveAs()));
		if (active && !isBuiltin(active.id)) {
			menu.addItem((i) => i.setTitle(t("profiles.update", { name: active.name })).setIcon("refresh-cw").onClick(() => {
				this.host.update(active.id);
				this.refresh();
				new Notice(t("profiles.updated", { name: active.name }));
			}));
			menu.addItem((i) => i.setTitle(t("profiles.delete", { name: active.name })).setIcon("trash").onClick(() => {
				const kept = this.host.remove(active.id);
				this.refresh();
				new Notice(t(kept ? "profiles.deletedSetKept" : "profiles.deleted", { name: active.name }), kept ? 7000 : undefined);
			}));
		}
		const r = this.button.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	private pick(id: string): void {
		this.host.apply(id);
		this.refresh();
	}

	private saveAs(): void {
		new PromptModal(this.host.app, { title: t("profiles.saveAs"), label: t("profiles.name.label"), cta: t("profiles.name.cta") }, (value) => {
			if (!cleanProfileName(value)) return;
			if (!this.host.saveAs(value)) {
				new Notice(t("profiles.limit", { n: String(MAX_PROFILES) }));
				return;
			}
			this.refresh();
			new Notice(t("profiles.created", { name: value.trim() }));
		}).open();
	}
}
