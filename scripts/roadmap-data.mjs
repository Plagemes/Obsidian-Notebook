// Builds the data of the public roadmap page (site/index.html) from docs/roadmap.md and CHANGELOG.md.
// Node built-ins only (the Pages workflow runs it without `npm ci`) and no network access.
//
// One row per numbered roadmap feature (`12. **P1** …`) and per lettered one (`- **O4 P1** …`, `- **Z3 P2** …`):
//   id, title, priority, milestone, milestoneTitle, area (the section heading), status and release.
// Status:
//   done      a 🧪 mark after the priority (implemented and released; hardware verification is tracked in docs/testing.md);
//   progress  a 🚧 mark, or an id listed in docs/roadmap-in-progress.txt (or passed with --in-progress);
//   dropped   struck through (~~…~~);
//   deferred  struck through and "moved to" / "rimandata" / "study and exam update", or a to-do item of a gated milestone
//             (M5, AI: only after the writing engine is stable);
//   todo      everything else.
// Release: the oldest CHANGELOG version whose text names the item ("roadmap 63, 64"), else the release sets below.
//
// Usage: node scripts/roadmap-data.mjs [--out=site/roadmap.json] [--in-progress=12,O3] [--wave=0.13.0]
//                                      [--generated-at=2026-10-30T12:00:00Z]
// `generatedAt` is the only value that is not a function of the two documents: it is --generated-at, else
// SOURCE_DATE_EPOCH (seconds), else the current time.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Releases of items that the CHANGELOG does not name by roadmap id (kept from the maintainer's dashboard script).
// 0.12.x shipped the design system and the creation dialog, which are not numbered roadmap items; a future release
// that closes numbered items is picked up from the CHANGELOG ("roadmap N") without a change here.
export const RELEASE_SETS = [
	["0.12.1", ""],
	["0.12.0", ""],
	["0.11.0", "105"],
	["0.10.0", "7 18 27 38 50 51 54 63 64 65 68 81 353 356 359 362 363 O15"],
	["0.9.0", "110 113 357 361 367 370 372 376 379 381 382 384 385 389"],
	["0.8.0", "100 139 201 202 203 204 208 209 223 303 374 378 388 O8 Z4"],
	["0.7.0", "342 343 344 345 346 347 364 365 366 380 387 390"],
	["0.6.0", "2 3 4 14 15 26 36 43 44 73 74 85 106 115 119 125 142 149 160 168 188 191 192 193 199 329 O2 O16 Z1 Z2 Z3 Z11 Z12"],
	["0.5.0", "1 5 6 62 91 95 97 104 114 122 140 151 152 155 172 176 180 185 196 211 216 235 255 271 O1 O4 O6 O9 O14 O20"],
	// The 0.4.0 CHANGELOG lists the scanner, the instant save journal, version history, embeds and obsidian:// links.
	["0.4.0", "22 25 29 31 58"],
].map(([version, ids]) => [version, new Set(ids.split(" ").filter(Boolean))]);
export const EARLY = "0.4.1 or earlier";

/** id → oldest CHANGELOG version that names it as "roadmap <ids>". */
export function changelogReleases(text) {
	const found = new Map();
	let version = "";
	for (const line of text.split(/\r?\n/)) {
		const h = /^## (\d+\.\d+\.\d+)\b/.exec(line);
		if (h) {
			version = h[1];
			continue;
		}
		if (!version) continue;
		for (const m of line.matchAll(/\broadmap\s+([^;)\]]+)/gi)) {
			for (let token of m[1].split(/,|\band\b/)) {
				token = token.trim().replace(/^M\d+\s+/, "").replace(/^#/, "");
				// The CHANGELOG is newest first: the last match is the oldest release.
				if (/^[OZ]?\d+$/.test(token)) found.set(token, version);
			}
		}
	}
	return found;
}

/** Ids from a list: separated by spaces, commas or newlines; `#` starts a comment. */
export function parseIdList(text) {
	return new Set(
		text
			.split(/\r?\n/)
			.map((l) => l.replace(/#.*$/, ""))
			.flatMap((l) => l.split(/[\s,]+/))
			.filter(Boolean),
	);
}

function cleanTitle(rest, priorityMark) {
	let title = rest.slice(rest.indexOf(priorityMark) + priorityMark.length).replace(/^\s*(🧪|🚧)\s*/, "").replace(/~~.*$/, "").trim();
	title = title.replace(/\*\*/g, "").replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	const cut = title.search(/(?<!\be\.g|\bi\.e)[:.](\s|$)/);
	if (cut > 5) title = title.slice(0, cut);
	if (title.length > 90) title = title.slice(0, 87).trimEnd() + "…";
	return title;
}

export function parseRoadmap(text, { released = new Map(), inProgress = new Set(), wave = "" } = {}) {
	let milestone = "";
	let milestoneTitle = "";
	let section = "";
	let gated = false;
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		const h2 = /^## (.+)$/.exec(line);
		if (h2) {
			const [code = "", rest = ""] = h2[1].split(" — ");
			milestone = code.trim();
			milestoneTitle = rest.replace(/\s*\(.*$/, "").replace(/\s*—.*$/, "").trim();
			section = milestoneTitle;
			// M5 (AI) starts only once writing and persistence are stable; "only after …" in a heading gates a milestone too.
			gated = milestone.startsWith("M5") || /only after/i.test(h2[1]);
			continue;
		}
		const h3 = /^### (.+)$/.exec(line);
		if (h3) {
			section = h3[1].replace(/^[A-G]\.\s*/, "").replace(/\s*\(.*$/, "").replace(/\s*—.*$/, "").trim();
			continue;
		}
		let id;
		let rest;
		let m = /^(\d+)\.\s+(.*)$/.exec(line);
		if (m) {
			id = m[1];
			rest = m[2] ?? "";
		} else {
			m = /^-?\s*(~~)?\*\*([OZ]\d+)\s+(P[123])\*\*(.*)$/.exec(line.trim());
			if (!m) continue;
			id = m[2];
			rest = `${m[1] ?? ""}**${m[3]}**${m[4]}`;
		}
		if (!id) continue;
		const prio = /\*\*(P[123])\*\*/.exec(rest);
		if (!prio) continue;
		const struck = /^(🧪\s*)?~~/.test(rest.trim());
		const head = rest.slice(0, rest.indexOf(prio[0]) + prio[0].length + 4);
		const done = head.includes("🧪");
		const building = head.includes("🚧");
		const title = cleanTitle(rest, prio[0]);

		let status;
		let release = "";
		if (struck) status = /moved|rimandat|Study and exam/i.test(line) ? "deferred" : "dropped";
		else if (inProgress.has(id) || building) {
			status = "progress";
			release = wave;
		} else if (done) {
			status = "done";
			release = released.get(id) ?? RELEASE_SETS.find(([, ids]) => ids.has(id))?.[0] ?? EARLY;
		} else status = gated ? "deferred" : "todo";
		rows.push({ id, title, priority: prio[1], milestone, milestoneTitle, area: section || milestoneTitle || milestone, status, release });
	}
	return rows;
}

const STATUSES = ["done", "progress", "todo", "deferred", "dropped"];

/** The whole data file from the text of the two documents. Pure: the same input gives the same output. */
export function buildRoadmap({ roadmap, changelog, inProgress = new Set(), wave = "", generatedAt }) {
	const rows = parseRoadmap(roadmap, { released: changelogReleases(changelog), inProgress, wave });
	const seen = new Set();
	for (const r of rows) {
		if (seen.has(r.id)) throw new Error(`roadmap-data: duplicate id ${r.id}`);
		seen.add(r.id);
	}
	const counts = { total: rows.length, ...Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])) };
	const milestones = [];
	for (const r of rows) {
		let ms = milestones.find((x) => x.id === r.milestone);
		if (!ms) milestones.push((ms = { id: r.milestone, title: r.milestoneTitle, features: 0 }));
		ms.features++;
	}
	const releases = [...new Set(rows.filter((r) => r.status === "done").map((r) => r.release))];
	const latest = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})/m.exec(changelog);
	return {
		generatedAt,
		source: "docs/roadmap.md and CHANGELOG.md",
		latestRelease: latest?.[1] ?? "",
		latestReleaseDate: latest?.[2] ?? "",
		counts,
		// One line for the README's shields.io badge (dynamic JSON, query $.badge).
		badge: `${counts.done} shipped · ${counts.progress} in progress · ${counts.todo} to do`,
		milestones,
		releases,
		features: rows,
	};
}

function main() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const arg = (name, fallback = "") => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
	const out = resolve(root, arg("out", "site/roadmap.json"));
	const listFile = join(root, "docs/roadmap-in-progress.txt");
	const inProgress = parseIdList(`${existsSync(listFile) ? readFileSync(listFile, "utf8") : ""}\n${arg("in-progress")}`);
	const epoch = process.env["SOURCE_DATE_EPOCH"];
	const generatedAt = arg("generated-at") || (epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000).toISOString() : new Date().toISOString());
	const data = buildRoadmap({
		roadmap: readFileSync(join(root, "docs/roadmap.md"), "utf8"),
		changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
		inProgress,
		wave: arg("wave"),
		generatedAt,
	});
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
	const c = data.counts;
	console.log(`roadmap-data: ${c.total} features: done ${c.done}, in progress ${c.progress}, to do ${c.todo}, deferred ${c.deferred}, dropped ${c.dropped} → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
