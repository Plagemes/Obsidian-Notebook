/** Folder tree for the sidebar, built from plain paths. Pure, no 'obsidian'. */
import { collatorCompare } from "./format";

export interface FolderNode {
	/** Full vault path. */
	path: string;
	name: string;
	children: FolderNode[];
}

/** Subfolders of the notebooks folder that are not part of the library. */
export const RESERVED_FOLDERS: readonly string[] = ["_assets", "_backup"];

/** True if `path` lies in a reserved subtree directly under `root`. */
export function isReservedPath(path: string, root: string): boolean {
	const rel = root === "" ? path : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
	if (rel === null || rel === "") return false;
	return RESERVED_FOLDERS.includes(rel.split("/")[0]!);
}

const lastSegment = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Builds the tree rooted at `root` from folder paths under it; missing parents are implied. */
export function buildFolderTree(root: string, folderPaths: readonly string[]): FolderNode {
	const rootNode: FolderNode = { path: root, name: lastSegment(root), children: [] };
	const nodes = new Map<string, FolderNode>([[root, rootNode]]);
	const ensure = (path: string): FolderNode | null => {
		const hit = nodes.get(path);
		if (hit) return hit;
		if (root !== "" && !path.startsWith(`${root}/`)) return null;
		const parent = ensure(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
		if (!parent) return null;
		const node: FolderNode = { path, name: lastSegment(path), children: [] };
		nodes.set(path, node);
		parent.children.push(node);
		return node;
	};
	for (const p of folderPaths) {
		if (p !== "" && p !== root && !isReservedPath(p, root)) ensure(p);
	}
	const sort = (n: FolderNode) => {
		n.children.sort((a, b) => collatorCompare(a.name, b.name));
		n.children.forEach(sort);
	};
	sort(rootNode);
	return rootNode;
}

/** Every folder of the tree, depth first, root included. */
export function flattenTree(node: FolderNode): FolderNode[] {
	return [node, ...node.children.flatMap(flattenTree)];
}

/** Ancestors from `root` down to `path`, as breadcrumb parts. */
export function breadcrumb(root: string, path: string): Array<{ path: string; name: string }> {
	const parts = [{ path: root, name: lastSegment(root) }];
	if (path === root || (root !== "" && !path.startsWith(`${root}/`))) return parts;
	let cur = root;
	for (const seg of (root === "" ? path : path.slice(root.length + 1)).split("/")) {
		cur = cur === "" ? seg : `${cur}/${seg}`;
		parts.push({ path: cur, name: seg });
	}
	return parts;
}
