import { describe, expect, it } from "vitest";
import { downscaledName, hasTransparency, mimeOf, outputFormat, targetSize, worthKeeping, canDownscale, DOWNSCALE_MAX_EDGE } from "../src/library/storage-image-logic";
import {
	conflictCandidates, DAY_MS, judgeConflict, notebookRef, parseBackupName, planBackups, RECOVERY_REASONS, SNAPSHOTS_KEPT_MIN, type FileInfo,
} from "../src/storage/storage-backups";
import { serialize } from "../src/model/serialize";
import { sampleDocument } from "./helpers";

const NOW = Date.parse("2026-11-01T12:00:00");
const FOLDER = "Notebooks/_backup";
const file = (path: string, size = 100): FileInfo => ({ path, size, mtime: NOW });
const bak = (base: string, stamp: string, reason = "before-move", hash = "0a1b2c3d") => file(`${FOLDER}/${base} ${stamp} ${reason} ${hash}.bak`);
const snap = (doc: string, stamp: string) => file(`${FOLDER}/history/${doc}/${stamp}.snapshot`);

describe("backup file names", () => {
	it("reads the notebook, the reason and the date from a name", () => {
		const n = parseBackupName("Physics 2 20260101-101500 before-restore 3 0a1b2c3d.bak");
		expect(n).toMatchObject({ base: "Physics 2", reason: "before-restore" });
		expect(new Date(n!.at).getFullYear()).toBe(2026);
	});

	it("rejects names that are not ours", () => {
		for (const name of ["notes.bak", "Physics 20260101-101500.bak", "Physics 20261301-101500 x 0a1b2c3d.bak", "Physics 20260101-101500 before-move 0a1b2c3d.txt"]) {
			expect(parseBackupName(name)).toBeNull();
		}
	});
});

describe("which backups are old enough to offer", () => {
	const notebooks = [notebookRef("Notebooks/Physics.notebook", "doc-physics"), notebookRef("Notebooks/Maths.notebook", "doc-maths")];

	it("offers backups older than the threshold, never the newest of a notebook, never young ones", () => {
		const plan = planBackups(
			[bak("Physics", "20250101-100000"), bak("Physics", "20250601-100000"), bak("Physics", "20260101-100000"), bak("Physics", "20261020-100000"), bak("Maths", "20240101-100000")],
			FOLDER, notebooks, NOW,
		);
		expect(plan.old.map((o) => o.path)).toEqual([
			`${FOLDER}/Physics 20250101-100000 before-move 0a1b2c3d.bak`,
			`${FOLDER}/Physics 20250601-100000 before-move 0a1b2c3d.bak`,
			`${FOLDER}/Physics 20260101-100000 before-move 0a1b2c3d.bak`,
		]);
		// Maths has one backup, old but the newest it has: it stays.
		expect(plan.old.some((o) => o.notebook.includes("Maths"))).toBe(false);
	});

	it("a backup of a notebook that is not in the vault any more is kept: it may be the only copy", () => {
		const plan = planBackups([bak("Gone", "20200101-100000"), bak("Gone", "20200201-100000")], FOLDER, notebooks, NOW);
		expect(plan.old).toEqual([]);
		expect(plan.unattributedBytes).toBe(200);
	});

	it("a name two notebooks share belongs to neither", () => {
		const twin = [notebookRef("Notebooks/A/Notes.notebook", "a"), notebookRef("Notebooks/B/Notes.notebook", "b")];
		const plan = planBackups([bak("Notes", "20200101-100000"), bak("Notes", "20200201-100000")], FOLDER, twin, NOW);
		expect(plan.old).toEqual([]);
		expect(plan.bytesByNotebook.size).toBe(0);
		expect(plan.unattributedBytes).toBe(200);
	});

	it("marks backups made to keep something that could not be saved or read as recovery copies", () => {
		const files = [...RECOVERY_REASONS, "before-restore"].map((reason, i) => bak("Physics", `2025010${i + 1}-100000`, reason, `0a1b2c3${i}`));
		files.push(bak("Physics", "20261020-100000"));
		const plan = planBackups(files, FOLDER, notebooks, NOW);
		expect(plan.old.filter((o) => o.recovery).map((o) => o.reason).sort()).toEqual([...RECOVERY_REASONS].sort());
		expect(plan.old.find((o) => o.reason === "before-restore")!.recovery).toBe(false);
	});

	it("the newest ORDINARY backup stays: a newer recovery copy does not stand in for it", () => {
		const plan = planBackups(
			[bak("Physics", "20250101-100000"), bak("Physics", "20250601-100000"), bak("Physics", "20260101-100000", "unreadable", "1a1b2c3d")],
			FOLDER, notebooks, NOW,
		);
		// The 2025-06 backup is the newest good one and stays; the older good one and the (newest overall) recovery copy are offered.
		expect(plan.old.map((o) => [o.at > 0, o.reason, o.recovery]).sort()).toEqual([[true, "before-move", false], [true, "unreadable", true]]);
		expect(plan.old.some((o) => o.path.includes("20250601"))).toBe(false);
		// Only recovery copies: the newest of them stays.
		const only = planBackups([bak("Physics", "20250101-100000", "unreadable"), bak("Physics", "20250601-100000", "unreadable", "1a1b2c3d")], FOLDER, notebooks, NOW);
		expect(only.old.map((o) => o.path)).toEqual([`${FOLDER}/Physics 20250101-100000 unreadable 0a1b2c3d.bak`]);
	});

	it("nothing is offered for a notebook that cannot be read now, but its sizes still count", () => {
		const broken = [notebookRef("Notebooks/Physics.notebook", "doc-physics", false, false)];
		const plan = planBackups(
			[bak("Physics", "20240101-100000"), bak("Physics", "20250101-100000"), bak("Physics", "20260101-100000"), snap("doc-physics", "20200101-1000"), snap("doc-physics", "20200201-1000"), snap("doc-physics", "20200301-1000"), snap("doc-physics", "20200401-1000"), snap("doc-physics", "20200501-1000")],
			FOLDER, broken, NOW,
		);
		expect(plan.old).toEqual([]);
		expect(plan.countByNotebook.get("Notebooks/Physics.notebook")).toBe(8);
		// The same notebook readable: offered.
		const ok = planBackups([bak("Physics", "20240101-100000"), bak("Physics", "20260101-100000")], FOLDER, [notebookRef("Notebooks/Physics.notebook", "doc-physics")], NOW);
		expect(ok.old).toHaveLength(1);
	});

	it("version history: old snapshots beyond the newest few of a notebook that exists", () => {
		const names = ["20240101-1000", "20240201-1000", "20240301-1000", "20240401-1000", "20260101-1000", "20261020-1000"];
		const plan = planBackups(names.map((n) => snap("doc-physics", n)), FOLDER, notebooks, NOW, { keepSnapshots: 2 });
		// keep = max(3, 2) newest: 20261020, 20260101, 20240401 stay; the rest are old.
		expect(plan.old.map((o) => o.path.slice(o.path.lastIndexOf("/") + 1))).toEqual(["20240101-1000.snapshot", "20240201-1000.snapshot", "20240301-1000.snapshot"]);
		expect(SNAPSHOTS_KEPT_MIN).toBe(3);
		const more = planBackups(names.map((n) => snap("doc-physics", n)), FOLDER, notebooks, NOW, { keepSnapshots: 5 });
		expect(more.old.map((o) => o.path.slice(o.path.lastIndexOf("/") + 1))).toEqual(["20240101-1000.snapshot"]);
	});

	it("the snapshots of a document no notebook has are kept; so are young ones", () => {
		const gone = planBackups(["20200101-1000", "20200201-1000", "20200301-1000", "20200401-1000"].map((n) => snap("doc-gone", n)), FOLDER, notebooks, NOW);
		expect(gone.old).toEqual([]);
		const young = planBackups(["20261001-1000", "20261002-1000", "20261003-1000", "20261004-1000"].map((n) => snap("doc-physics", n)), FOLDER, notebooks, NOW, { keepSnapshots: 1 });
		expect(young.old).toEqual([]);
	});

	it("a copy made by sync shares its notebook's document id but does not own the history; if the copy is all there is, it does", () => {
		const both = [notebookRef("Notebooks/Physics.notebook", "doc-physics"), notebookRef("Notebooks/Physics (1).notebook", "doc-physics", true)];
		const names = ["20240101-1000", "20240201-1000", "20240301-1000", "20240401-1000", "20260101-1000"].map((n) => snap("doc-physics", n));
		const plan = planBackups(names, FOLDER, both, NOW);
		expect(plan.old.map((o) => o.notebook)).toEqual(["Notebooks/Physics.notebook", "Notebooks/Physics.notebook"]);
		const alone = planBackups(names, FOLDER, [notebookRef("Notebooks/Physics (1).notebook", "doc-physics", true)], NOW);
		expect(alone.old.map((o) => o.notebook)).toEqual(["Notebooks/Physics (1).notebook", "Notebooks/Physics (1).notebook"]);
		// Two real notebooks with one id (a manual copy that is not named like one) stay ambiguous.
		const twins = [notebookRef("Notebooks/A.notebook", "doc-physics"), notebookRef("Notebooks/B.notebook", "doc-physics")];
		expect(planBackups(names, FOLDER, twins, NOW).old).toEqual([]);
	});

	it("attributes the bytes and counts of every backup and snapshot to its notebook", () => {
		const plan = planBackups([bak("Physics", "20261020-100000"), snap("doc-physics", "20261020-1000"), snap("doc-maths", "20261020-1000")], FOLDER, notebooks, NOW);
		expect(plan.bytesByNotebook.get("Notebooks/Physics.notebook")).toBe(200);
		expect(plan.countByNotebook.get("Notebooks/Physics.notebook")).toBe(2);
		expect(plan.bytesByNotebook.get("Notebooks/Maths.notebook")).toBe(100);
		expect(plan.files).toBe(3);
	});

	it("ignores files that are not backups, outside the backup folder or inside other folders of it", () => {
		const plan = planBackups(
			[file(`${FOLDER}/readme.txt`), file("Elsewhere/Physics 20200101-100000 before-move 0a1b2c3d.bak"), file(`${FOLDER}/other/Physics 20200101-100000 before-move 0a1b2c3d.bak`), file(`${FOLDER}/history/doc-physics/notes.snapshot`)],
			FOLDER, notebooks, NOW,
		);
		expect(plan.files).toBe(0);
		expect(plan.old).toEqual([]);
	});

	it("respects a shorter or longer threshold", () => {
		const files = [bak("Physics", "20260901-100000"), bak("Physics", "20261020-100000")];
		expect(planBackups(files, FOLDER, notebooks, NOW, { days: 30 }).old).toHaveLength(1);
		expect(planBackups(files, FOLDER, notebooks, NOW, { days: 90 }).old).toHaveLength(0);
		expect(DAY_MS).toBe(86_400_000);
	});
});

describe("conflicted copies", () => {
	it("finds notebooks named like a copy of a sibling in the same folder only", () => {
		const found = conflictCandidates([
			{ path: "Notebooks/Notes.notebook", size: 1 },
			{ path: "Notebooks/Notes (1).notebook", size: 1 },
			{ path: "Notebooks/Notes-DESKTOP-AB12CD.notebook", size: 1 },
			{ path: "Notebooks/Other/Notes (2).notebook", size: 1 },
			{ path: "Notebooks/Plain.notebook", size: 1 },
		]);
		expect(found.map((f) => [f.path, f.main, f.maybeManual])).toEqual([
			["Notebooks/Notes (1).notebook", "Notebooks/Notes.notebook", true],
			["Notebooks/Notes-DESKTOP-AB12CD.notebook", "Notebooks/Notes.notebook", false],
		]);
	});

	it("is identical only when both read the same and carry the same id", () => {
		const doc = sampleDocument(2);
		const text = serialize(doc);
		const c = { path: "Notebooks/N (1).notebook", main: "Notebooks/N.notebook", size: 1, maybeManual: true };
		expect(judgeConflict(c, text, text, { copy: doc.id, main: doc.id }).identical).toBe(true);
		expect(judgeConflict(c, text, text, { copy: doc.id, main: "other" }).identical).toBe(false);
		expect(judgeConflict(c, text, text, { copy: null, main: null }).identical).toBe(false);
		const edited = sampleDocument(3);
		expect(judgeConflict(c, serialize(edited), text, { copy: doc.id, main: doc.id }).identical).toBe(false);
		expect(judgeConflict(c, "{not a notebook", "{also not", { copy: "x", main: "x" }).identical).toBe(false);
	});
});

describe("downscaling decisions", () => {
	it("scales the long side down to the limit, keeps the ratio and never enlarges", () => {
		expect(targetSize(4000, 3000)).toEqual({ width: DOWNSCALE_MAX_EDGE, height: 1536 });
		expect(targetSize(3000, 4000)).toEqual({ width: 1536, height: DOWNSCALE_MAX_EDGE });
		expect(targetSize(1000, 800)).toEqual({ width: 1000, height: 800 });
		expect(targetSize(10_000, 1)).toEqual({ width: DOWNSCALE_MAX_EDGE, height: 1 });
		expect(targetSize(0, 0)).toEqual({ width: 1, height: 1 });
		expect(targetSize(5000, 5000, 1000)).toEqual({ width: 1000, height: 1000 });
	});

	it("keeps a smaller copy only when it is clearly smaller", () => {
		expect(worthKeeping(1000, 900)).toBe(true);
		expect(worthKeeping(1000, 901)).toBe(false);
		expect(worthKeeping(1000, 0)).toBe(false);
		expect(worthKeeping(1000, 1200)).toBe(false);
	});

	it("leaves animated formats alone and knows the mime types", () => {
		expect(canDownscale("a/b.PNG")).toBe(true);
		expect(canDownscale("a/b.jpeg")).toBe(true);
		expect(canDownscale("a/b.webp")).toBe(true);
		expect(canDownscale("a/b.gif")).toBe(false);
		expect(canDownscale("a/b.pdf")).toBe(false);
		expect(mimeOf("x.jpg")).toBe("image/jpeg");
		expect(mimeOf("x.webp")).toBe("image/webp");
		expect(mimeOf("x.png")).toBe("image/png");
	});

	it("transparency decides the format and the name", () => {
		expect(hasTransparency([255, 0, 0, 255, 0, 0, 0, 255])).toBe(false);
		expect(hasTransparency([255, 0, 0, 255, 0, 0, 0, 254])).toBe(true);
		expect(outputFormat(true)).toEqual({ mime: "image/png", ext: "png" });
		expect(outputFormat(false)).toEqual({ mime: "image/jpeg", ext: "jpg" });
		expect(downscaledName("photo.final.png", "jpg")).toBe("photo.final.jpg");
		expect(downscaledName("", "jpg")).toBe("image.jpg");
		// A file named by its asset id keeps no id in its display name.
		expect(downscaledName("844075c79b6708fddbd9965c.jpg", "jpg")).toBe("image.jpg");
	});
});
