// Copies the curated harness screenshots into docs/media/ for the README and the roadmap page (npm run harness:media).
//
// Run `npm run harness:check` first: it writes the screenshots to dev/harness/dist/shots/. Each image is downscaled in
// headless Chrome (high-quality smoothing) to at most `width` pixels wide, optionally cropped to a rectangle first, and
// written as PNG (or WebP at quality 0.92 for the large, gradient-heavy ones). The banner, the social preview and the art
// bands are copied unchanged (exact size).
// Prints each file with its size; exit code 1 if a source is missing or a file is over the size budget.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome } from "./chrome.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "dist", "shots");
const media = resolve(here, "../../docs/media");
const BUDGET = 400 * 1024;

/** Copied unchanged: [source under dist/shots, file in docs/media]. */
const COPY = [
	["banner/banner-dark.png", "banner-dark.png"],
	["banner/banner-light.png", "banner-light.png"],
	["banner/social-dark.png", "social-preview.png"],
	["banner/band-dark.png", "art-band-dark.png"],
	["banner/band-light.png", "art-band-light.png"],
];

/**
 * Screenshots scaled into docs/media/: source under dist/shots, file in docs/media (.png, or .webp for a lossy image at
 * quality 0.92 where a PNG would be far over the budget), max width, optional crop rectangle [x, y, w, h] in source pixels.
 */
const SCALE = [
	["design/home-dark-reference.png", "home-dark.webp", 1200],
	["design/home-light-reference.png", "home-light.webp", 1200],
	["design/library-dark-reference.png", "library-dark.webp", 1200],
	["design/library-light-reference.png", "library-light.webp", 1200],
	["ui/tabletLandscape-dark-radial-main.png", "notebook-dark.png", 1200],
	["ui/tabletLandscape-light-radial-main.png", "notebook-light.png", 1200],
	["ui/tabletLandscape-dark-radial-color.png", "radial-color-dark.png", 700, [640, 420, 1280, 900]],
	["ui/tabletLandscape-light-radial-color.png", "radial-color-light.png", 700, [640, 420, 1280, 900]],
	["ui/tabletLandscape-dark-radial-shapes.png", "radial-shapes-dark.png", 700, [640, 420, 1280, 900]],
	["ui/tabletLandscape-light-radial-shapes.png", "radial-shapes-light.png", 700, [640, 420, 1280, 900]],
	["create-dark-tablet.png", "create-notebook-dark.png", 700],
	["create-light-tablet.png", "create-notebook-light.png", 700],
	["create-dark-tablet-folder.png", "create-folder-dark.png", 700],
	["create-light-tablet-folder.png", "create-folder-light.png", 700],
	["settings-dark-desktop.png", "settings-dark.png", 1200],
	["settings-light-desktop.png", "settings-light.png", 1200],
	// The subject cards of the gallery page (below its title, above the covers).
	["art/art-dark-mix-tablet.png", "art-gallery-dark.webp", 1000, [0, 500, 1600, 1730]],
	["art/art-light-mix-tablet.png", "art-gallery-light.webp", 1000, [0, 500, 1600, 1730]],
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
		for (const [from, to, width, rect] of SCALE) {
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
				const [sx, sy, sw, sh] = ${JSON.stringify(rect ?? null)} ?? [0, 0, img.naturalWidth, img.naturalHeight];
				const k = Math.min(1, ${width} / sw);
				// Halve in steps for a clean downscale, then the final size.
				let canvas = document.createElement("canvas");
				canvas.width = sw;
				canvas.height = sh;
				canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
				const tw = Math.round(sw * k), th = Math.round(sh * k);
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
				return ${to.endsWith(".webp")} ? final.toDataURL("image/webp", 0.92).split(",")[1] : final.toDataURL("image/png").split(",")[1];
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
