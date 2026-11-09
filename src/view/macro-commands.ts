// 0.27 macros (#170): one Obsidian command per macro ("Macro: <name>"), so a macro can have a hotkey and sits in the command palette and the
// mobile toolbar. The commands follow the settings: added, renamed and removed as the macros change. Only a notebook view in front can run one.
import type { Plugin } from "obsidian";
import { t } from "../i18n";
import { macroActionId, setMacros, type Macro } from "../ui/macros";
import type { NotebookView } from "./notebook-view";

/** The id of the command of a macro (the plugin adds its own prefix). */
export const macroCommandId = (id: string): string => `macro-run-${id}`;

export class MacroCommands {
	private added: string[] = [];
	private signature = "";

	constructor(private readonly plugin: Plugin, private readonly activeView: () => NotebookView | null) {}

	/** Makes `macros` the macros of the registry and of the command palette. Cheap when nothing changed. */
	sync(macros: readonly Macro[]): void {
		setMacros(macros);
		const signature = JSON.stringify(macros.map((m) => [m.id, m.name, m.icon]));
		if (signature === this.signature) return;
		this.signature = signature;
		for (const id of this.added) this.plugin.removeCommand(id);
		this.added = [];
		for (const m of macros) {
			const id = macroCommandId(m.id);
			this.plugin.addCommand({
				id, name: t("macros.command.run", { name: m.name }), icon: m.icon,
				checkCallback: (checking) => {
					const view = this.activeView();
					if (!view) return false;
					if (!checking) view.runAction(macroActionId(m.id));
					return true;
				},
			});
			this.added.push(id);
		}
	}
}
