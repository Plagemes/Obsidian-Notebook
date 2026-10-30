// Copies the curated harness screenshots into docs/media/ for the README and the roadmap page (npm run harness:media).
//
// Run `npm run harness:check` first: it writes the screenshots to dev/harness/dist/shots/. Each image is downscaled in
// headless Chrome (high-quality smoothing) to at most `width` CSS pixels wide, optionally cropped to `crop` pixels of
// height first, and written as PNG. The banner, the social preview and the art bands are copied unchanged (exact size).
// Prints each file with its size; exit code 1 if a source is missing or a file is over the size budget.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome } from "./chrome.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "dist", "shots");
const media = resolve(here, "../../docs/media");
const BUDGET = 400 * 1024;

/** [source under dist/shots, file in docs/media, max width, optional crop height in source pixels]. */
const COPY = [
	["banner/banner-dark.png", "banner-dark.png"],
	["banner/banner-light.png", "banner-light.png"],
	["banner/social-dark.png", "social-preview.png"],
	["banner/band-dark.png", "art-band-dark.png"],
	["banner/band-light.png", "art-band-light.png"],
];
const SCALE = [
	["design/home-dark-reference.png", "home-dark.png", 1200],
	["design/home-light-reference.png", "home-light.png", 1200],
	["design/library-dark-reference.png", "library-dark.png", 1200],
	["design/library-light-reference.png", "library-light.png", 1200],
	["ui/tabletLandscape-dark-radial-main.png", "notebook-dark.png", 1200],
	["ui/tabletLandscape-light-radial-main.png", "notebook-light.png", 1200],
	["create-dark-tablet.png", "create-notebook-dark.png", 700],
	["create-light-tablet.png", "create-notebook-light.png", 700],
	["create-dark-tablet-folder.png", "create-folder-dark.png", 700],
	["create-light-tablet-folder.png", "create-folder-light.png", 700],
	["settings-dark-desktop.png", "settings-dark.png", 1200],
	["settings-light-desktop.png", "settings-light.png", 1200],
	["art/art-dark-mix-desktopHiDpi.png", "art-gallery-dark.png", 1200, 1000],
	["art/art-light-mix-desktopHiDpi.png", "art-gallery-light.png", 1200, 1000],
];

async function main() {
	mkdirSync(media, { recursive: true });
	let failed = false;
	const report = (name) => {
		const size = statSync(join(media, name)).size;
		const over = !name.startsWith("banner") && !name.startsWith("social") && size > BUDGET;
		if (over) failed = true;
		console.log(`${over ? "OVER" : "ok  "} docs/media/${name}  ${Math.round(size / 1024)} KB`);
	};
	for (const [from, to] of COPY) {
		const src = join(shots, from);
		if (!existsSync(src)) {
			console.log(`MISSING dist/shots/${from}`);
			failed = true;
			continue;
		}
		copyFileSync(src, join(media, to));
		report(to);
	}
	const chrome = findChrome();
	if (!chrome) {
		console.error("harness:media: no Chrome/Chromium/Edge found. Set CHROME_PATH.");
		process.exit(2);
	}
	const { cdp, close } = await launchChrome(chrome);
	try {
		for (const [from, to, width, crop] of SCALE) {
			const src = join(shots, from);
			if (!existsSync(src)) {
				console.log(`MISSING dist/shots/${from}`);
				failed = true;
				continue;
			}
			const url = `data:image/png;base64,${readFileSync(src).toString("base64")}`;
			const out = await cdp.evaluate(`(async () => {
				const img = new Image();
				img.src = ${JSON.stringify(url)};
				await img.decode();
				const sh = Math.min(img.naturalHeight, ${crop ?? 0} || img.naturalHeight);
				const k = Math.min(1, ${width} / img.naturalWidth);
				// Halve in steps for a clean downscale, then the final size.
				let canvas = document.createElement("canvas");
				canvas.width = img.naturalWidth;
				canvas.height = sh;
				canvas.getContext("2d").drawImage(img, 0, 0, img.naturalWidth, sh, 0, 0, img.naturalWidth, sh);
				const tw = Math.round(img.naturalWidth * k), th = Math.round(sh * k);
				while (canvas.width / 2 >= tw) {
					const half = document.createElement("canvas");
					half.width = Math.round(canvas.width / 2);
					half.height = Math.round(canvas.height / 2);
					const c = half.getContext("2d");
					c.imageSmoothingQuality = "high";
					c.drawImage(canvas, 0, 0, half.width, half.height);
					canvas = half;
				}
				const final = document.createElement("canvas");
				final.width = tw;
				final.height = th;
				const c = final.getContext("2d");
				c.imageSmoothingQuality = "high";
				c.drawImage(canvas, 0, 0, tw, th);
				return final.toDataURL("image/png").split(",")[1];
			})()`, 60000);
			writeFileSync(join(media, to), Buffer.from(out, "base64"));
			report(to);
		}
	} finally {
		cdp.close();
		await close();
	}
	process.exit(failed ? 1 : 0);
}

await main();
