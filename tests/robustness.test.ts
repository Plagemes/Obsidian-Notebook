import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ getLanguage: () => "en", apiVersion: "1.14.4", Platform: {}, setIcon: () => undefined }));

const { artFailures, artImage, coverImage, emptyStateImage, folderIconSvg, setArtCanvasFactory } = await import("../src/ui/art/generative-art");
const { errorMessage, firstStackFrame } = await import("../src/ui/components/error-card");
const { chromeVersion, deviceInfoLines } = await import("../src/view/device-info");

// 0.12.3: decoration never breaks a layout; failures can be read off a screenshot.
describe("the art engine drops decoration instead of throwing", () => {
	afterEach(() => vi.restoreAllMocks());

	it("a canvas that cannot be made gives no image, logs once and switches the engine off after three failures", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		setArtCanvasFactory(() => {
			throw new Error("HierarchyRequestError: Only one element on document allowed.");
		});
		expect(artImage({ seed: "a", color: "#F0565E" }, 320, 128, 2)).toBe("");
		expect(emptyStateImage({ seed: "b", color: "#2F80F7" }, 280, 150, 2)).toBe("");
		expect(artFailures()).toMatchObject({ count: 2, off: false });
		expect(coverImage({ seed: "c", color: "#8B5CF6" }, 180, 252, 2)).toBe("");
		expect(artFailures()).toMatchObject({ count: 3, off: true, last: "HierarchyRequestError: Only one element on document allowed." });
		// Off: nothing more is tried, nothing more is logged.
		expect(artImage({ seed: "d", color: "#16C2A3" }, 320, 128, 2)).toBe("");
		expect(artFailures().count).toBe(3);
		expect(log).toHaveBeenCalledTimes(1);
		expect(String(log.mock.calls[0]![0])).toMatch(/^\[notebook\] art: /);
		// The folder icon is plain SVG markup and still works.
		expect(folderIconSvg("#F0565E", 64)).toMatch(/^<svg /);
	});

	it("a new canvas factory starts again", () => {
		setArtCanvasFactory(() => ({ width: 0, height: 0, getContext: () => null, toDataURL: () => "data:image/png;base64,x" }));
		expect(artFailures()).toMatchObject({ count: 0, off: false });
		expect(artImage({ seed: "e", color: "#F0565E" }, 10, 10, 1)).toBe("");
	});
});

describe("error cards", () => {
	it("name the error and its first stack frame (Chrome and Safari stacks)", () => {
		const e = new TypeError("x is not a function");
		e.stack = "TypeError: x is not a function\n    at CreateDialog.render (plugin:notebook:1:2345)\n    at CreateDialog.onOpen (plugin:notebook:1:999)";
		expect(errorMessage(e)).toBe("TypeError: x is not a function");
		expect(firstStackFrame(e)).toBe("CreateDialog.render (plugin:notebook:1:2345)");
		const s = new Error("boom");
		s.stack = "render@capacitor://localhost/main.js:1:2345\nonOpen@capacitor://localhost/main.js:1:99";
		expect(errorMessage(s)).toBe("boom");
		expect(firstStackFrame(s)).toBe("render@capacitor://localhost/main.js:1:2345");
		expect(firstStackFrame("not an error")).toBe("");
		expect(errorMessage("plain")).toBe("plain");
	});
});

describe("Diagnostics → Device info", () => {
	const ua = "Mozilla/5.0 (Linux; Android 14; SM-X710 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/108.0.5359.128 Safari/537.36";

	it("reads the WebView's Chrome version from the user agent", () => {
		expect(chromeVersion(ua)).toBe("108.0.5359.128");
		expect(chromeVersion("Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit/605.1.15 Version/17.0 Safari/604.1")).toBeNull();
	});

	it("lists the WebView, Obsidian's version, the platform flags that are on, the screen and the art engine", () => {
		const lines = deviceInfoLines({
			userAgent: ua, apiVersion: "1.14.4", flags: { isMobile: true, isAndroidApp: true, isTablet: true, isPhone: false },
			screen: { width: 1280, height: 800, dpr: 2 }, art: { count: 3, last: "boom", off: true },
		});
		expect(lines).toEqual([
			"WebView: Chrome 108.0.5359.128",
			"Obsidian API: 1.14.4",
			"Platform: isMobile, isAndroidApp, isTablet",
			"Screen: 1280×800 @2x",
			"Art engine: off after 3 failure(s): boom",
			`User agent: ${ua}`,
		]);
	});
});
