import type { Plugin } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { WithView } from "./commands";
import type { PdfReading } from "./pdf-reading";

interface ReadingCommand {
	id: string;
	name: MessageKey;
	run: (reading: PdfReading) => void;
}

/** The PDF reading commands (wave 0.6). No default hotkeys, as for the other commands. */
export const READING_COMMANDS: readonly ReadingCommand[] = [
	{ id: "pdf-search", name: "command.pdfSearch", run: (r) => r.openSearch() },
	{ id: "pdf-search-next", name: "command.pdfSearchNext", run: (r) => r.step(1) },
	{ id: "pdf-search-previous", name: "command.pdfSearchPrev", run: (r) => r.step(-1) },
	{ id: "toggle-annotations", name: "command.annotationsToggle", run: (r) => r.toggleAnnotations() },
	{ id: "toggle-dim-background", name: "command.dimToggle", run: (r) => r.toggleDim() },
];

/** Registers the commands; each one applies to the active notebook view. */
export function registerReadingCommands(plugin: Plugin, withView: WithView): void {
	for (const cmd of READING_COMMANDS) {
		plugin.addCommand({
			id: cmd.id,
			name: t(cmd.name),
			checkCallback: (checking) => withView(checking, (view) => {
				const reading = view.readingTools;
				if (reading) cmd.run(reading);
			}),
		});
	}
}
