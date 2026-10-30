import type { Plugin } from "obsidian";
import { t } from "../i18n";
import { ACTIONS, type ActionDef } from "../ui/actions";
import type { NotebookView } from "./notebook-view";

export interface CommandDeps {
	/** The active notebook view, or null. */
	activeView(): NotebookView | null;
	/** Handlers of the plugin-level actions (scope "global"), by id. */
	globals: Readonly<Record<string, () => void>>;
}

/** The actions that are commands registered here: view and global ones (external modules register their own). */
export function commandActions(): ActionDef[] {
	return ACTIONS.filter((a) => a.command && a.scope !== "external");
}

/** Display name of a command; the favourite commands carry their slot number. */
export function commandName(a: ActionDef): string {
	const key = typeof a.command === "string" ? a.command : a.label;
	const m = /^favourite-(\d+)$/.exec(a.id);
	return m ? t(key, { n: m[1]! }) : t(key);
}

/**
 * Registers every command of the action registry (ui/actions.ts) with its stable id, so hotkeys keep working. No default
 * hotkeys: they would clash with the user's own. View commands apply to the active notebook view and only show in the
 * palette while one is active (and, for the side-by-side ones, while they apply). Returns the ids of global actions
 * without a handler (a programming error, reported by the caller).
 */
export function registerActionCommands(plugin: Plugin, deps: CommandDeps): string[] {
	const missing: string[] = [];
	for (const a of commandActions()) {
		if (a.scope === "global") {
			const run = deps.globals[a.id];
			if (!run) {
				missing.push(a.id);
				continue;
			}
			plugin.addCommand({ id: a.id, name: commandName(a), callback: run });
			continue;
		}
		plugin.addCommand({
			id: a.id,
			name: commandName(a),
			checkCallback: (checking) => {
				const view = deps.activeView();
				if (!view || !view.commandApplies(a.id)) return false;
				if (!checking) view.runAction(a.id);
				return true;
			},
		});
	}
	return missing;
}
