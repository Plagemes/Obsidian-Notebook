import type { TAbstractFile, Vault } from "obsidian";

/** The one `Vault` method this module uses. */
interface PluginFileRemover {
	delete(file: TAbstractFile, force?: boolean): Promise<void>;
}

/**
 * Deletes one of the plugin's OWN bookkeeping files or folders straight away, exactly like `Vault.delete`: this
 * device's presence and device files, page-trash entry files (after their page was restored and saved, by the retention
 * limits, or a first-layout file once every entry in it reads back from its own file), and the library trash's meta
 * file and item folder (a move that failed, or the meta file left behind by a restore).
 *
 * Never call it for the user's notes, notebooks, attachments or anything they asked to delete: those go through
 * `FileManager.trashFile`, which follows the user's "Deleted files" setting. Moving these small technical files to the
 * user's trash instead would fill it with one file per opened notebook or restored page. Every call site and why its
 * target is plugin-internal: docs/architecture.md, "Deleting files".
 */
export function deletePluginFile(vault: Vault, file: TAbstractFile, force?: boolean): Promise<void> {
	const remover: PluginFileRemover = vault;
	return force === undefined ? remover.delete(file) : remover.delete(file, force);
}
