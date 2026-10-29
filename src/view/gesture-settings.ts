import { Setting, type SettingDefinitionItem } from "obsidian";
import { t } from "../i18n";
import { DEFAULT_GESTURE_SETTINGS, type GestureSettings } from "../ink/gesture-settings";

/** What the settings tab gives the gesture settings: current values and a setter (validated by readSettings). */
export interface GestureSettingsHost {
	get(): GestureSettings;
	set(key: keyof GestureSettings, value: unknown): Promise<void>;
}

const tapOptions = () => ({
	"undo-redo": t("settings.tapGestures.undoRedo"),
	"redo-undo": t("settings.tapGestures.redoUndo"),
	off: t("settings.tapGestures.off"),
});

/** Declarative definitions (Obsidian 1.13+), appended to the plugin's list. */
export function gestureSettingDefinitions(_host: GestureSettingsHost): SettingDefinitionItem<keyof GestureSettings>[] {
	return [
		{
			name: t("settings.tapGestures"),
			desc: t("settings.tapGestures.desc"),
			control: { type: "dropdown", key: "tapGestures", defaultValue: DEFAULT_GESTURE_SETTINGS.tapGestures, options: tapOptions() },
		},
		{
			name: t("settings.scribble"),
			desc: t("settings.scribble.desc"),
			control: { type: "toggle", key: "scribbleErase", defaultValue: DEFAULT_GESTURE_SETTINGS.scribbleErase },
		},
		{
			name: t("settings.autoScroll"),
			desc: t("settings.autoScroll.desc"),
			control: { type: "toggle", key: "autoScrollWriting", defaultValue: DEFAULT_GESTURE_SETTINGS.autoScrollWriting },
		},
	];
}

/** Fallback for Obsidian older than 1.13 (classic settings tab). */
export function displayGestureSettings(containerEl: HTMLElement, host: GestureSettingsHost): void {
	const s = host.get();
	new Setting(containerEl)
		.setName(t("settings.tapGestures"))
		.setDesc(t("settings.tapGestures.desc"))
		.addDropdown((dd) => dd.addOptions(tapOptions()).setValue(s.tapGestures).onChange((v) => host.set("tapGestures", v)));
	new Setting(containerEl)
		.setName(t("settings.scribble"))
		.setDesc(t("settings.scribble.desc"))
		.addToggle((tg) => tg.setValue(s.scribbleErase).onChange((v) => host.set("scribbleErase", v)));
	new Setting(containerEl)
		.setName(t("settings.autoScroll"))
		.setDesc(t("settings.autoScroll.desc"))
		.addToggle((tg) => tg.setValue(s.autoScrollWriting).onChange((v) => host.set("autoScrollWriting", v)));
}
