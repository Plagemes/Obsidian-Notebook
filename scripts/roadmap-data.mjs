// Builds the data of the public roadmap page (site/index.html) from docs/roadmap.md and CHANGELOG.md.
//
// One row per numbered roadmap feature (`12. **P1** …`) and per lettered one (`- **O4 P1** …`, `- **Z3 P2** …`):
//   id, title, priority, milestone, area (the section heading), status and release.
// Status: 🧪 after the priority = done (implemented and released; hardware verification is tracked in docs/testing.md),
// 🚧 after the priority (or an id passed with --in-progress) = in progress, struck through = dropped, or deferred when the
// note says it was moved; to-do items of M5 (AI, only after the writing engine is stable) count as deferred.
// Release: the oldest CHANGELOG version whose text names the item ("roadmap 63, 64"), else the release sets below.
//
// Also copies the header art of the page (docs/media/art-band-dark.png and -light.png) into site/media/.
//
// Usage: node scripts/roadmap-data.mjs [--out=site/roadmap.json] [--in-progress=12,O3] [--wave=0.13.0]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback = "") => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(root, arg("out", "site/roadmap.json"));
const inProgress = new Set(arg("in-progress").split(",").map((s) => s.trim()).filter(Boolean));
const wave = arg("wave");

// Releases of items that the CHANGELOG does not name by roadmap id (kept from the maintainer's dashboard script).
const RELEASE_SETS = [
	["0.12.0", ""],
	["0.11.0", "105"],
	["0.10.0", "7 18 27 38 50 51 54 63 64 65 68 81 353 356 359 362 363 O15"],
	["0.9.0", "110 113 357 361 367 370 372 376 379 381 382 384 385 389"],
	["0.8.0", "100 139 201 202 203 204 208 209 223 303 374 378 388 O8 Z4"],
	["0.7.0", "342 343 344 345 346 347 364 365 366 380 387 390"],
	["0.6.0", "2 3 4 14 15 26 36 43 44 73 74 85 106 115 119 125 142 149 160 168 188 191 192 193 199 329 O2 O16 Z1 Z2 Z3 Z11 Z12"],
	["0.5.0", "1 5 6 62 91 95 97 104 114 122 140 151 152 155 172 176 180 185 196 211 216 235 255 271 O1 O4 O6 O9 O14 O20"],
].map(([version, ids]) => [version, new Set(ids.split(" ").filter(Boolean))]);
const EARLY = "0.4.1 or earlier";

/** id → oldest CHANGELOG version that names it as "roadmap <ids>". */
function changelogReleases(text) {
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

function parseRoadmap(text, released) {
	let milestone = "";
	let milestoneTitle = "";
	let section = "";
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		const h2 = /^## (.+)$/.exec(line);
		if (h2) {
			const [code, rest = ""] = h2[1].split(" — ");
			milestone = code.trim();
			milestoneTitle = rest.replace(/\s*\(.*$/, "").replace(/\s*—.*$/, "").trim();
			section = milestoneTitle;
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
			rest = m[2];
		} else {
			m = /^-?\s*(~~)?\*\*([OZ]\d+)\s+(P[123])\*\*(.*)$/.exec(line.trim());
			if (!m) continue;
			id = m[2];
			rest = `${m[1] ?? ""}**${m[3]}**${m[4]}`;
		}
		const prio = /\*\*(P[123])\*\*/.exec(rest);
		if (!prio) continue;
		const struck = /^(🧪\s*)?~~/.test(rest.trim());
		const head = rest.slice(0, rest.indexOf(prio[0]) + prio[0].length + 4);
		const done = head.includes("🧪");
		const building = head.includes("🚧");
		let title = rest.slice(rest.indexOf(prio[0]) + prio[0].length).replace(/^\s*(🧪|🚧)\s*/, "").replace(/~~.*$/, "").trim();
		title = title.replace(/\*\*/g, "").replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
		const cut = title.search(/[:.](\s|$)/);
		if (cut > 5) title = title.slice(0, cut);
		if (title.length > 90) title = title.slice(0, 87).trimEnd() + "…";

		let status;
		let release = "";
		if (struck) status = /moved|Study and exam/i.test(line) ? "deferred" : "dropped";
		else if (inProgress.has(id) || building) {
			status = "progress";
			release = wave;
		} else if (done) {
			status = "done";
			release = released.get(id) ?? RELEASE_SETS.find(([, ids]) => ids.has(id))?.[0] ?? EARLY;
		} else status = "todo";
		if (milestone.startsWith("M5") && status === "todo") status = "deferred";
		rows.push({ id, title, priority: prio[1], milestone, milestoneTitle, area: section || milestoneTitle || milestone, status, release });
	}
	return rows;
}

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const rows = parseRoadmap(readFileSync(join(root, "docs/roadmap.md"), "utf8"), changelogReleases(changelog));
const seen = new Set();
for (const r of rows) {
	if (seen.has(r.id)) throw new Error(`roadmap-data: duplicate id ${r.id}`);
	seen.add(r.id);
}
const count = (s) => rows.filter((r) => r.status === s).length;
const counts = { total: rows.length, done: count("done"), progress: count("progress"), todo: count("todo"), deferred: count("deferred"), dropped: count("dropped") };
const latest = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})/m.exec(changelog);
const data = {
	source: "docs/roadmap.md and CHANGELOG.md",
	latestRelease: latest?.[1] ?? "",
	latestReleaseDate: latest?.[2] ?? "",
	counts,
	// One line for the README's shields.io badge (dynamic JSON, query $.badge).
	badge: `${counts.done} shipped · ${counts.progress} in progress · ${counts.todo} to do`,
	features: rows,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
const media = join(dirname(out), "media");
mkdirSync(media, { recursive: true });
for (const name of ["art-band-dark.png", "art-band-light.png"]) {
	const from = join(root, "docs/media", name);
	if (existsSync(from)) copyFileSync(from, join(media, name));
	else console.warn(`roadmap-data: ${from} is missing; the page header will have no art`);
}
console.log(`roadmap-data: ${counts.total} features: done ${counts.done}, in progress ${counts.progress}, to do ${counts.todo}, deferred ${counts.deferred}, dropped ${counts.dropped} → ${out}`);
