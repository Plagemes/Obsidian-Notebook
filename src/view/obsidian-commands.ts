import type { App } from "obsidian";

/**
 * The command registry of Obsidian. It is not part of the published typings (`app.commands`), but every plugin that binds
 * hotkeys or runs other plugins' commands relies on it. Everything here is guarded, so a version without it does nothing.
 */
interface CommandRegistry {
	executeCommandById(id: string): boolean;
	listCommands(): Array<{ id: string; name: string }>;
	commands?: Record<string, { id: string; name: string } | undefined>;
}

function registry(app: App): CommandRegistry | null {
	const r = (app as unknown as { commands?: Partial<CommandRegistry> }).commands;
	return r && typeof r.executeCommandById === "function" ? (r as CommandRegistry) : null;
}

export interface CommandInfo {
	id: string;
	name: string;
}

/** Every command Obsidian knows (core and plugins), by name. */
export function listCommands(app: App): CommandInfo[] {
	const r = registry(app);
	if (!r) return [];
	try {
		const list = typeof r.listCommands === "function" ? r.listCommands() : Object.values(r.commands ?? {}).filter((c): c is CommandInfo => !!c);
		return list.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

export function commandName(app: App, id: string): string | null {
	return listCommands(app).find((c) => c.id === id)?.name ?? null;
}

/** Runs the command; false when it does not exist or could not run. */
export function runCommand(app: App, id: string): boolean {
	try {
		return registry(app)?.executeCommandById(id) ?? false;
	} catch (e) {
		console.error("[notebook] gesture command failed", id, e);
		return false;
	}
}
