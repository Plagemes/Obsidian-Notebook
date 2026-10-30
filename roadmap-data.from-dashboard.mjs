// Builds the roadmap dashboard data (one row per numbered roadmap feature) from docs/roadmap.md.
// Usage: node roadmap-data.mjs <roadmap.md> <out.json> [in-progress ids, comma separated] [wave label]
import { readFileSync, writeFileSync } from "node:fs";

const [src, out, progressArg = "", wave = ""] = process.argv.slice(2);
const inProgress = new Set(progressArg.split(",").map((s) => s.trim()).filter(Boolean));
const RELEASE_0110 = new Set(["105"]);
const RELEASE_0100 = new Set("7 18 27 38 50 51 54 63 64 65 68 81 353 356 359 362 363 O15".split(" "));
const RELEASE_090 = new Set("110 113 357 361 367 370 372 376 379 381 382 384 385 389".split(" "));
const RELEASE_080 = new Set("100 139 201 202 203 204 208 209 223 303 374 378 388 O8 Z4".split(" "));
const RELEASE_070 = new Set("342 343 344 345 346 347 364 365 366 380 387 390".split(" "));
const RELEASE_060 = new Set("2 3 4 14 15 26 36 43 44 73 74 85 106 115 119 125 142 149 160 168 188 191 192 193 199 329 O2 O16 Z1 Z2 Z3 Z11 Z12".split(" "));
const RELEASE_050 = new Set("1 5 6 62 91 95 97 104 114 122 140 151 152 155 172 176 180 185 196 211 216 235 255 271 O1 O4 O6 O9 O14 O20".split(" "));

const lines = readFileSync(src, "utf8").split(/\r?\n/);
let milestone = "";
let section = "";
const rows = [];
for (const line of lines) {
	const h2 = /^## (.+)$/.exec(line);
	if (h2) {
		milestone = h2[1].split(" — ")[0].trim();
		section = h2[1].includes(" — ") ? h2[1].split(" — ")[1].replace(/\s*\(.*$/, "").trim() : "";
		continue;
	}
	const h3 = /^### (.+)$/.exec(line);
	if (h3) {
		section = h3[1].replace(/^[A-G]\.\s*/, "").replace(/\s*\(.*$/, "").trim();
		continue;
	}
	let m = /^(\d+)\.\s+(.*)$/.exec(line);
	let id;
	let rest;
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
	const struck = rest.trimStart().startsWith("~~") || /^🧪?\s*~~/.test(rest.trim());
	const done = /🧪/.test(rest.slice(0, rest.indexOf(prio[0]) + prio[0].length + 4));
	let title = rest.slice(rest.indexOf(prio[0]) + prio[0].length).replace(/^\s*🧪\s*/, "").replace(/~~.*$/, "").trim();
	title = title.replace(/\*\*/g, "").replace(/`/g, "");
	const cut = title.search(/[:.](\s|$)/);
	if (cut > 5) title = title.slice(0, cut);
	if (title.length > 90) title = title.slice(0, 87).trimEnd() + "…";

	let status;
	let release = "";
	if (struck) status = /moved|Study and exam/i.test(line) ? "Rimandata" : "Scartata";
	else if (inProgress.has(id)) {
		status = "In sviluppo";
		release = wave;
	} else if (done) {
		status = "Fatta";
		release = RELEASE_0110.has(id) ? "0.11.0" : RELEASE_0100.has(id) ? "0.10.0" : RELEASE_090.has(id) ? "0.9.0" : RELEASE_080.has(id) ? "0.8.0" : RELEASE_070.has(id) ? "0.7.0" : RELEASE_060.has(id) ? "0.6.0" : RELEASE_050.has(id) ? "0.5.0" : "0.4.1 o prima";
	} else status = "Da fare";
	if (milestone.startsWith("M5") && status === "Da fare") status = "Rimandata";
	rows.push({ id, title, priority: prio[1], milestone, area: section || milestone, status, release });
}
const seen = new Set();
for (const r of rows) {
	if (seen.has(r.id)) throw new Error(`duplicate id ${r.id}`);
	seen.add(r.id);
}
writeFileSync(out, JSON.stringify(rows, null, 1));
const count = (s) => rows.filter((r) => r.status === s).length;
console.log(`${rows.length} features: fatte ${count("Fatta")}, in sviluppo ${count("In sviluppo")}, da fare ${count("Da fare")}, scartate ${count("Scartata")}, rimandate ${count("Rimandata")}`);
