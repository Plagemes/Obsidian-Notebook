import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { buildHtml, escapeHtml, htmlPage, ImageBudget, pageHtmlLinks, safeUrl, scopeSvgIds } from "../src/ink/export-html";
import { pageToSvg } from "../src/ink/export-svg";
import { planExport } from "../src/ink/export-layers";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, type Page, type TextElement } from "../src/model/types";

function page(id: string, elements: TextElement[] = []): Page {
	return { id, width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "blank", spacing: PAPER_SPACING.blank }, strokes: [], elements };
}
const text = (t: string): TextElement => ({ id: "t1", type: "text", x: 40, y: 40, width: 300, text: t, fontSize: 14, color: "#000000" });

describe("interactive HTML export (#164)", () => {
	it("plans one file with all the pages of the choice", () => {
		const jobs = planExport("html", "range", 0, 6, "both", [4, 1]);
		expect(jobs).toEqual([{ format: "html", pages: [1, 4], suffix: " p2+5" }]);
		expect(planExport("html", "notebook", 0, 3)).toEqual([{ format: "html", pages: [0, 1, 2], suffix: "" }]);
		expect(planExport("html", "page", 2, 3, "ink")[0]!.suffix).toBe(" p3 ink");
	});

	it("escapes the title in the document and in the labels (no markup gets through)", () => {
		const title = `</title><script>alert(1)</script>"&'`;
		const html = buildHtml({ title, labels: { page: "<b>P</b>", of: "o", fit: "</script><img src=x onerror=1>", zoomIn: "+", zoomOut: "-", prev: "<", next: ">", pages: "p" } }, [{ svg: pageToSvg(page("a")), label: `<img src=x onerror=1>` }]);
		expect(html).not.toContain("<script>alert(1)");
		expect(html).not.toContain("<img src=x onerror=1>");
		expect(html).toContain("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;</title>");
		// The only script elements are the labels and the viewer.
		expect((html.match(/<script/g) ?? []).length).toBe(2);
		expect(html).toContain("data-label=\"&lt;img src=x onerror=1&gt;\"");
		expect(escapeHtml("<a href=\"x\">&</a>")).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
	});

	it("keeps text of the page escaped in the SVG and never makes a network request", () => {
		const html = buildHtml({ title: "N" }, [{ svg: pageToSvg(page("a", [text("<script>alert(1)</script> & <img onerror=x>")])), label: "Page 1" }]);
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;alert(1)");
		expect(html).toContain("default-src 'none'");
		expect(html).not.toMatch(/(src|href)="https?:/);
		expect(html).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/);
	});

	it("gives each page its own clip path names", () => {
		const svg = '<svg><clipPath id="nb-graph-1"><rect/></clipPath><g clip-path="url(#nb-graph-1)"/></svg>';
		expect(scopeSvgIds(svg, 2)).toBe('<svg><clipPath id="p3-nb-graph-1"><rect/></clipPath><g clip-path="url(#p3-nb-graph-1)"/></svg>');
		const html = buildHtml({ title: "N" }, [{ svg, label: "1" }, { svg, label: "2" }]);
		expect(html).toContain('id="p1-nb-graph-1"');
		expect(html).toContain('id="p2-nb-graph-1"');
		expect(html).not.toContain('id="nb-graph-1"');
	});

	it("links to a page of the notebook stay in the file, web links open normally, other links are left alone", () => {
		const els = [{ ...text("see [[My Notebook#p2]] and [[Other note]] and [[https://example.com/a?b=1|site]]") }];
		const links = pageHtmlLinks(page("a", els), "My Notebook", (n) => (n === 2 ? 1 : null));
		expect(links.map((l) => l.page ?? l.url)).toEqual([2, "https://example.com/a?b=1"]);
		expect(pageHtmlLinks(page("a", els), "My Notebook", () => null).map((l) => l.page ?? l.url)).toEqual(["https://example.com/a?b=1"]);
		const out = htmlPage(0, 3, "<svg></svg>", "Page 1", links);
		expect(out).toContain('<a href="#p2" data-go="2">');
		expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">');
		expect(out.endsWith("</section>\n")).toBe(true);
	});

	it("drops unsafe link targets", () => {
		expect(safeUrl("javascript:alert(1)")).toBeNull();
		expect(safeUrl("data:text/html,x")).toBeNull();
		expect(safeUrl('https://a.com/"onmouseover="x')).toBeNull();
		expect(safeUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
		const out = htmlPage(0, 1, "<svg></svg>", "1", [{ x: 0, y: 0, width: 5, height: 5, url: "javascript:alert(1)" }, { x: 0, y: 0, width: 5, height: 5, page: 9 }]);
		expect(out).not.toContain("<a ");
	});

	it("stops embedding pictures at the size cap and counts what it left out", () => {
		const b = new ImageBudget(100);
		expect(b.take("x".repeat(60))).toBe(true);
		expect(b.take("x".repeat(60))).toBe(false);
		expect(b.take("x".repeat(40))).toBe(true);
		expect(b.take("x")).toBe(false);
		expect(b.omitted).toBe(2);
		expect(b.used).toBe(100);
	});

	it("has the viewer: page strip, keyboard, fit width, dark mode", () => {
		const html = buildHtml({ title: "N" }, [{ svg: pageToSvg(page("a")), label: "1" }, { svg: pageToSvg(page("b")), label: "2" }]);
		expect(html).toContain("prefers-color-scheme:dark");
		expect(html).toContain('id="strip"');
		expect(html).toContain("ArrowRight");
		expect(html).toContain('id="fit"');
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(html.trimEnd().endsWith("</html>")).toBe(true);
	});
});

describe("the viewer on large notebooks and on paper", () => {
	const html = buildHtml({ title: "N" }, [{ svg: pageToSvg(page("a")), label: "1" }, { svg: pageToSvg(page("b")), label: "2" }]);
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

	it("renders the page strip on demand, not one clone of every page when the file opens", () => {
		// A placeholder with the page's aspect ratio per page; the picture is cloned only when its thumbnail comes into view.
		expect(script).toContain("new IntersectionObserver");
		expect(script).toContain("className='ph'");
		expect(script).toContain("aspectRatio");
		// The only clone of a page SVG is inside fill(), which build() reaches only from the observer (or without one).
		expect(script.match(/cloneNode\(true\)/g)).toHaveLength(1);
		const build = /function build\(\)\{([\s\S]*?)\n\}\n/.exec(script)![1]!;
		expect(build).not.toContain("cloneNode");
		expect(build).toContain("io.observe(a)");
		expect(script.indexOf("function fill(a)")).toBeLessThan(script.indexOf("cloneNode(true)"));
		expect(script).toContain("io.unobserve(en.target)");
	});

	it("prints every page: all sections shown one per sheet, the viewer chrome hidden", () => {
		const css = /@media print\{([^`]*?)\}\}/.exec(html)![0];
		expect(css).toContain("div[hidden]{display:block}");
		expect(css).toContain("header,nav,#stage{display:none}");
		expect(css).toContain(".pg{break-after:page");
		expect(css).toContain(".pg svg{display:block;width:100%;height:auto");
		expect(html).toContain("@page{margin:10mm}");
		// The page on screen lives in the stage: it goes back to its section for printing and returns afterwards.
		expect(script).toContain("addEventListener('beforeprint'");
		expect(script).toContain("addEventListener('afterprint'");
		expect(script.lastIndexOf("pg[cur].appendChild(svgOf(cur))")).toBeGreaterThan(script.indexOf("beforeprint"));
		expect(script.lastIndexOf("sheet.appendChild(svgOf(cur))")).toBeGreaterThan(script.indexOf("afterprint"));
	});
});

describe("the inline viewer script", () => {
	it("is valid JavaScript (compiled, not run)", () => {
		const html = buildHtml({ title: "N" }, [{ svg: "<svg></svg>", label: "1" }]);
		const m = /<script>([\s\S]*?)<\/script>/.exec(html);
		expect(m).not.toBeNull();
		// esbuild parses it (and throws on a syntax error) without running it.
		expect(() => transformSync(m![1]!, { loader: "js", logLevel: "silent" })).not.toThrow();
	});
});
