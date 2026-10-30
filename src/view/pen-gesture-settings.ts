import { Setting, type SettingDefinitionItem } from "obsidian";
import { t } from "../i18n";
import { BUILTIN_GESTURES, type BuiltInGestureId } from "../ink/gestures/registry";
import { DEFAULT_PEN_GESTURE_SETTINGS, SPACE_PT_MAX, SPACE_PT_MIN, type PenGestureSettings } from "../ink/gestures/settings";
import { CustomGesturesModal, GestureCheatSheet, setGestureEnabled, type PenGestureUiHost } from "./pen-gesture-ui";

/** The settings tab keys of the per-gesture switches: "penGesture:select", ... */
export const GESTURE_KEY_PREFIX = "penGesture:";

export function gestureKeyId(key: string): BuiltInGestureId | null {
	if (!key.startsWith(GESTURE_KEY_PREFIX)) return null;
	const id = key.slice(GESTURE_KEY_PREFIX.length);
	return (BUILTIN_GESTURES as readonly string[]).includes(id) ? (id as BuiltInGestureId) : null;
}

/** Declarative definitions (Obsidian 1.13+) of the pen gesture section. The side button choice is in the button setting above. */
export function penGestureSettingDefinitions(host: PenGestureUiHost): SettingDefinitionItem[] {
	return [{
		type: "group",
		heading: t("settings.penGestures"),
		items: [
			{
				name: t("settings.penGestureLongPress"),
				desc: t("settings.penGestureLongPress.desc"),
				control: { type: "toggle", key: "penGestureLongPress", defaultValue: DEFAULT_PEN_GESTURE_SETTINGS.penGestureLongPress },
			},
			{
				name: t("settings.penGestureSpace"),
				desc: t("settings.penGestureSpace.desc"),
				control: {
					type: "slider", key: "penGestureSpacePt", defaultValue: DEFAULT_PEN_GESTURE_SETTINGS.penGestureSpacePt,
					min: SPACE_PT_MIN, max: SPACE_PT_MAX, step: 4, displayFormat: (v) => `${v} pt`,
				},
			},
			...BUILTIN_GESTURES.map((id) => ({
				name: t(`gesture.${id}.title`),
				desc: t(`gesture.${id}.how`),
				control: { type: "toggle" as const, key: `${GESTURE_KEY_PREFIX}${id}`, defaultValue: true },
			})),
			{
				name: t("settings.penGestureSheet"),
				desc: t("settings.penGestureSheet.desc"),
				action: () => new GestureCheatSheet(host).open(),
			},
			{
				name: t("settings.penGestureCustom"),
				desc: t("settings.penGestureCustom.desc"),
				action: () => new CustomGesturesModal(host).open(),
			},
		],
	}];
}

/** Fallback for Obsidian older than 1.13 (classic settings tab). */
export function displayPenGestureSettings(containerEl: HTMLElement, host: PenGestureUiHost): void {
	const s = host.get();
	new Setting(containerEl).setName(t("settings.penGestures")).setHeading();
	new Setting(containerEl)
		.setName(t("settings.penGestureLongPress"))
		.setDesc(t("settings.penGestureLongPress.desc"))
		.addToggle((tg) => tg.setValue(s.penGestureLongPress).onChange((v) => host.set("penGestureLongPress", v)));
	new Setting(containerEl)
		.setName(t("settings.penGestureSpace"))
		.setDesc(t("settings.penGestureSpace.desc"))
		.addSlider((sl) => sl.setLimits(SPACE_PT_MIN, SPACE_PT_MAX, 4).setValue(s.penGestureSpacePt).onChange((v) => host.set("penGestureSpacePt", v)));
	for (const id of BUILTIN_GESTURES) {
		new Setting(containerEl)
			.setName(t(`gesture.${id}.title`))
			.setDesc(t(`gesture.${id}.how`))
			.addToggle((tg) => tg.setValue(!s.penGesturesOff.includes(id)).onChange((v) => setGestureEnabled(host, id, v)));
	}
	new Setting(containerEl)
		.setName(t("settings.penGestureSheet"))
		.setDesc(t("settings.penGestureSheet.desc"))
		.addButton((b) => b.setButtonText(t("settings.penGestureSheet")).onClick(() => new GestureCheatSheet(host).open()));
	new Setting(containerEl)
		.setName(t("settings.penGestureCustom"))
		.setDesc(t("settings.penGestureCustom.desc"))
		.addButton((b) => b.setButtonText(t("settings.penGestureCustom")).onClick(() => new CustomGesturesModal(host).open()));
}

export type { PenGestureSettings };
