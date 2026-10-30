import { Setting, type App, type DropdownComponent, type SettingDefinitionItem } from "obsidian";
import { t } from "../i18n";
import {
	BUTTON_AFTER_MAX_MS, BUTTON_BEFORE_MAX_MS, DEFAULT_BUTTON_WINDOWS, PEN_KEY_PRESETS, capturedKey, hotkeyConflicts, type PenKeyAction,
} from "../ink/pen-hover";
import type { NotebookSettings } from "../settings";

/**
 * 0.11.2: the S Pen fallback settings ("Button click: next stroke erases", the pen key and its action). They belong in
 * the *Pen & input* section of the settings tab; until that section exists they are shown in the Pen button test.
 * Two forms, as for the other settings modules: declarative definitions (Obsidian 1.13+) and a classic renderer.
 */
export type PenButtonSettings = Pick<
	NotebookSettings,
	"penButtonEraserNext" | "penButtonKey" | "penButtonKeyAction" | "penButtonContactBeforeMs" | "penButtonContactAfterMs"
>;
export type PenButtonSettingKey = keyof PenButtonSettings;

/** Current values and a setter (saves the settings and applies them to the open notebooks). */
export interface PenButtonSettingsHost {
	get(): PenButtonSettings;
	set<K extends PenButtonSettingKey>(key: K, value: PenButtonSettings[K]): Promise<void>;
}

/** The value of the "Other key" choice in the key dropdown: it starts capturing a key instead of saving a value. */
const CAPTURE = "\u0000capture";
/** Capturing gives up after this long without a usable key. */
const CAPTURE_MS = 10_000;

const actionOptions = (): Record<PenKeyAction, string> => ({
	"eraser-next": t("settings.penButtonKeyAction.eraserNext"),
	menu: t("settings.penButtonKeyAction.menu"),
});

/** Names of the Obsidian commands bound to `key` without modifiers (`app.hotkeyManager`, not public: read defensively). */
export function penKeyConflictNames(app: App, key: string): string[] {
	const internal = app as unknown as { hotkeyManager?: unknown; commands?: { commands?: unknown } };
	let ids: string[] = [];
	try {
		ids = hotkeyConflicts(internal.hotkeyManager, key);
	} catch {
		return [];
	}
	const table = internal.commands?.commands;
	return ids.map((id) => {
		const cmd = typeof table === "object" && table !== null ? (table as Record<string, { name?: unknown } | undefined>)[id] : undefined;
		return typeof cmd?.name === "string" ? cmd.name : id;
	});
}

function keyDesc(app: App, key: string): string | DocumentFragment {
	const conflicts = key ? penKeyConflictNames(app, key) : [];
	if (conflicts.length === 0) return t("settings.penButtonKey.desc");
	return createFragment((f) => {
		f.appendText(t("settings.penButtonKey.desc"));
		f.createEl("br");
		f.createSpan({ cls: "mod-warning", text: t("settings.penButtonKey.conflict", { list: conflicts.join(", ") }) });
	});
}

function keyOptions(current: string): Record<string, string> {
	const o: Record<string, string> = { "": t("settings.penButtonKey.off") };
	for (const k of PEN_KEY_PRESETS) o[k] = k;
	if (current && !(PEN_KEY_PRESETS as readonly string[]).includes(current)) o[current] = t("settings.penButtonKey.customValue", { key: current === " " ? "Space" : current });
	o[CAPTURE] = t("settings.penButtonKey.other");
	return o;
}

/**
 * Renders the pen key row into `setting`: a dropdown (off, F9 to F12, the captured key, "Other key…") whose last
 * choice captures the next key pressed (Escape cancels). The description warns when an Obsidian hotkey uses the key.
 * `changed` runs after a new key is saved (to show or hide the key action). Returns a cleanup function.
 */
export function renderPenKeySetting(setting: Setting, app: App, host: PenButtonSettingsHost, changed: () => void): () => void {
	let stopCapture: () => void = () => {};
	let dropdown: DropdownComponent | null = null;
	const show = (): void => {
		const key = host.get().penButtonKey;
		setting.setDesc(keyDesc(app, key));
		if (!dropdown) return;
		dropdown.selectEl.empty();
		dropdown.addOptions(keyOptions(key));
		dropdown.setValue(key);
	};
	const save = async (key: string): Promise<void> => {
		await host.set("penButtonKey", key);
		show();
		changed();
	};
	const capture = (): void => {
		stopCapture();
		setting.setDesc(t("settings.penButtonKey.capturing"));
		const win = activeWindow;
		const onKey = (e: KeyboardEvent): void => {
			// The key is taken here: no other listener (Obsidian's hotkeys, a notebook view) acts on it.
			e.preventDefault();
			e.stopImmediatePropagation();
			if (e.key === "Escape") {
				stopCapture();
				show();
				return;
			}
			const key = capturedKey(e);
			if (key === null) return; // a modifier alone: wait for the real key
			stopCapture();
			void save(key);
		};
		const opts = { capture: true } as const;
		win.addEventListener("keydown", onKey, opts);
		const timer = win.setTimeout(() => {
			stopCapture();
			show();
		}, CAPTURE_MS);
		stopCapture = () => {
			win.removeEventListener("keydown", onKey, opts);
			win.clearTimeout(timer);
			stopCapture = () => {};
		};
	};
	setting.setName(t("settings.penButtonKey")).addDropdown((dd) => {
		dropdown = dd;
		dd.onChange((v) => {
			if (v === CAPTURE) {
				dd.setValue(host.get().penButtonKey);
				capture();
				return;
			}
			stopCapture();
			void save(v);
		});
	});
	show();
	return () => stopCapture();
}

/**
 * Declarative definitions (Obsidian 1.13+) for the *Pen & input* section: name, description, control and visibility (the
 * key action only when a key is set). `update` re-evaluates visibility (the settings tab's `update()`).
 */
export function penButtonSettingDefinitions(app: App, host: PenButtonSettingsHost, update: () => void): SettingDefinitionItem<PenButtonSettingKey>[] {
	return [
		{
			name: t("settings.penButtonEraserNext"),
			desc: t("settings.penButtonEraserNext.desc"),
			control: { type: "toggle", key: "penButtonEraserNext", defaultValue: false },
		},
		{
			name: t("settings.penButtonKey"),
			desc: t("settings.penButtonKey.desc"),
			aliases: ["Key Mapper", "Shizuku", "S Pen", ...PEN_KEY_PRESETS],
			render: (setting) => renderPenKeySetting(setting, app, host, update),
		},
		{
			name: t("settings.penButtonKeyAction"),
			desc: t("settings.penButtonKeyAction.desc"),
			visible: () => host.get().penButtonKey !== "",
			control: { type: "dropdown", key: "penButtonKeyAction", defaultValue: "eraser-next", options: actionOptions() },
		},
		{
			heading: t("settings.penButtonAdvanced"),
			type: "group",
			items: [
				{
					name: t("settings.penButtonBeforeMs"),
					desc: t("settings.penButtonBeforeMs.desc"),
					control: { type: "slider", key: "penButtonContactBeforeMs", defaultValue: DEFAULT_BUTTON_WINDOWS.beforeMs, min: 0, max: BUTTON_BEFORE_MAX_MS, step: 10 },
				},
				{
					name: t("settings.penButtonAfterMs"),
					desc: t("settings.penButtonAfterMs.desc"),
					control: { type: "slider", key: "penButtonContactAfterMs", defaultValue: DEFAULT_BUTTON_WINDOWS.afterMs, min: 0, max: BUTTON_AFTER_MAX_MS, step: 10 },
				},
			],
		},
	];
}

/** Classic renderer (Obsidian older than 1.13, and the Pen button test until the *Pen & input* section exists). Returns a cleanup function. */
export function displayPenButtonSettings(containerEl: HTMLElement, app: App, host: PenButtonSettingsHost): () => void {
	const s = host.get();
	new Setting(containerEl)
		.setName(t("settings.penButtonEraserNext"))
		.setDesc(t("settings.penButtonEraserNext.desc"))
		.addToggle((tg) => tg.setValue(s.penButtonEraserNext).onChange((v) => void host.set("penButtonEraserNext", v)));
	let actionRow: Setting | null = null;
	const refresh = (): void => actionRow?.settingEl.toggle(host.get().penButtonKey !== "");
	const cleanup = renderPenKeySetting(new Setting(containerEl), app, host, refresh);
	actionRow = new Setting(containerEl)
		.setName(t("settings.penButtonKeyAction"))
		.setDesc(t("settings.penButtonKeyAction.desc"))
		.addDropdown((dd) => dd.addOptions(actionOptions()).setValue(s.penButtonKeyAction).onChange((v) => {
			if (v === "menu" || v === "eraser-next") void host.set("penButtonKeyAction", v);
		}));
	refresh();
	new Setting(containerEl)
		.setName(t("settings.penButtonBeforeMs"))
		.setDesc(t("settings.penButtonBeforeMs.desc"))
		.addSlider((sl) => sl.setLimits(0, BUTTON_BEFORE_MAX_MS, 10).setValue(s.penButtonContactBeforeMs)
			.onChange((v) => void host.set("penButtonContactBeforeMs", v)));
	new Setting(containerEl)
		.setName(t("settings.penButtonAfterMs"))
		.setDesc(t("settings.penButtonAfterMs.desc"))
		.addSlider((sl) => sl.setLimits(0, BUTTON_AFTER_MAX_MS, 10).setValue(s.penButtonContactAfterMs)
			.onChange((v) => void host.set("penButtonContactAfterMs", v)));
	return cleanup;
}
