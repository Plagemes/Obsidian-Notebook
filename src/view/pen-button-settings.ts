import type { App, DropdownComponent, Setting } from "obsidian";
import { t } from "../i18n";
import { PEN_KEY_PRESETS, capturedKey, hotkeyConflicts } from "../ink/pen-hover";
import type { NotebookSettings } from "../settings";

/**
 * 0.11.2: the S Pen fallback settings ("Button click: next stroke erases", the pen key and its action, the side button
 * timing). Their rows are in the *Pen & input* section of the settings tab (PEN_BUTTON_EXTENSIONS in settings-schema.ts);
 * this module draws the one that needs its own control, the pen key (dropdown, key capture, hotkey warning).
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
