// 0.21 (#164): interactive HTML export, the pure part. One self-contained .html file: the inline SVG of every page (the same
// drawing as the SVG export), a few lines of vanilla JS (page strip, zoom and pan, keyboard) and no network of any kind
// (a Content-Security-Policy forbids it). Pure: no 'obsidian', no DOM. The view writes the file (view/export.ts).

import { escapeAttr } from "./export-svg";
import { linkRects } from "./link-text";
import type { Page, TextElement } from "../model/types";

/** Text of the viewer (English by default; the plugin passes its translation). */
export interface HtmlViewerLabels {
	page: string;
	of: string;
	fit: string;
	zoomIn: string;
	zoomOut: string;
	prev: string;
	next: string;
	pages: string;
}

export const DEFAULT_HTML_LABELS: HtmlViewerLabels = {
	page: "Page", of: "of", fit: "Fit width", zoomIn: "Zoom in", zoomOut: "Zoom out", prev: "Previous page", next: "Next page", pages: "Pages",
};

/** Largest total of embedded pictures, in characters of data URI (about 32 MB of file). Pictures over it are left out. */
export const HTML_IMAGE_BUDGET = 32 * 1024 * 1024;

/** Counts the pictures an export embeds against a size cap; a picture that does not fit is refused (and counted). */
export class ImageBudget {
	used = 0;
	omitted = 0;
	constructor(readonly max: number = HTML_IMAGE_BUDGET) {}

	/** Whether a picture with this `href` still fits; when it does it is counted. */
	take(href: string): boolean {
		if (this.used + href.length > this.max) {
			this.omitted++;
			return false;
		}
		this.used += href.length;
		return true;
	}
}

/** A link drawn over a page: a rectangle in page pt that goes to another page of the file, or to an address. */
export interface HtmlLink {
	x: number;
	y: number;
	width: number;
	height: number;
	/** 1-based page of the same file. */
	page?: number;
	/** http, https or mailto address (anything else is dropped). */
	url?: string;
}

/** Text escaped for HTML content. */
export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Only these address kinds are ever written as a link target. */
export function safeUrl(url: string): string | null {
	const u = url.trim();
	return /^(https?:\/\/|mailto:)[^\s<>"'`\\]+$/i.test(u) ? u : null;
}

const num = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * The links of a page: a wikilink to this notebook with a page subpath (`[[Name#p3]]`) goes to that page of the file (`fileIndexOf`: the
 * 0-based place in the file of a 1-based notebook page, null when that page is not in the file), a link whose
 * target is a web address opens it; any other note link has nowhere to go in a standalone file and is left as text.
 */
export function pageHtmlLinks(page: Page, notebookName: string, fileIndexOf: (notebookPage: number) => number | null): HtmlLink[] {
	const out: HtmlLink[] = [];
	const wanted = notebookName.trim().toLowerCase();
	for (const el of page.elements ?? []) {
		if (el.type !== "text" || typeof (el as TextElement).text !== "string" || !(el as TextElement).text.includes("[[")) continue;
		for (const r of linkRects(el as TextElement)) {
			const m = /^p(\d+)$/i.exec(r.link.subpath);
			const target = r.link.target.trim();
			const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
			if (m && target.toLowerCase().replace(/\.md$/, "") === wanted) {
				const n = Number(m[1]);
				const at = fileIndexOf(n);
				if (at !== null) out.push({ ...rect, page: at + 1 });
				continue;
			}
			const url = safeUrl(target + (r.link.subpath ? `#${r.link.subpath}` : ""));
			if (url) out.push({ ...rect, url });
		}
	}
	return out;
}

/** Gives the clip paths of the SVG of page `index` (0-based) names of their own: the pages share one document. */
export function scopeSvgIds(svg: string, index: number): string {
	const p = `p${index + 1}-`;
	return svg
		.replace(/<clipPath id="([^"]+)"/g, (_m, id: string) => `<clipPath id="${p}${id}"`)
		.replace(/clip-path="url\(#([^")]+)\)"/g, (_m, id: string) => `clip-path="url(#${p}${id})"`);
}

/** The links of a page as SVG anchors (a transparent rectangle each), to put just before `</svg>`. */
function linkTags(links: readonly HtmlLink[], pageCount: number): string {
	const tags: string[] = [];
	for (const l of links) {
		const rect = `<rect x="${num(l.x)}" y="${num(l.y)}" width="${num(l.width)}" height="${num(l.height)}" fill="transparent"/>`;
		if (l.page !== undefined && Number.isInteger(l.page) && l.page >= 1 && l.page <= pageCount) {
			tags.push(`<a href="#p${l.page}" data-go="${l.page}">${rect}</a>`);
			continue;
		}
		const url = l.url ? safeUrl(l.url) : null;
		if (url) tags.push(`<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${rect}</a>`);
	}
	return tags.join("");
}

export interface HtmlHead {
	title: string;
	labels?: HtmlViewerLabels;
	/** Language of the file (`lang` attribute). */
	lang?: string;
}

const CSS = `:root{color-scheme:light dark;--bg:#f4f4f5;--bar:#ffffff;--fg:#18181b;--mut:#71717a;--line:#e4e4e7;--acc:#2563eb;--sh:0 1px 3px rgba(0,0,0,.18),0 6px 20px rgba(0,0,0,.08)}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--bar:#1c1c1f;--fg:#f4f4f5;--mut:#a1a1aa;--line:#2e2e33;--acc:#60a5fa;--sh:0 1px 3px rgba(0,0,0,.6),0 6px 20px rgba(0,0,0,.4)}}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bar);border-bottom:1px solid var(--line)}
header h1{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{font:inherit;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:8px;min-width:36px;height:34px;padding:0 10px;cursor:pointer}
button:hover{border-color:var(--acc)}button:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:1px}button:disabled{opacity:.4;cursor:default}
#pos{color:var(--mut);min-width:84px;text-align:center;font-variant-numeric:tabular-nums}
main{flex:1;display:flex;min-height:0}
nav{width:128px;flex:none;overflow:auto;padding:10px;background:var(--bar);border-right:1px solid var(--line);display:flex;flex-direction:column;gap:10px}
nav a{display:block;text-decoration:none;color:var(--mut);text-align:center;font-size:12px;border:2px solid transparent;border-radius:6px;padding:3px}
nav a[aria-current=page]{border-color:var(--acc);color:var(--fg)}nav a svg,nav a .ph{display:block;width:100%;height:auto;background:#fff;box-shadow:var(--sh);margin-bottom:3px}
#stage{flex:1;min-width:0;overflow:auto;touch-action:pan-x pan-y;padding:16px;cursor:grab}
#stage.drag{cursor:grabbing;user-select:none}
#sheet{margin:0 auto;width:max-content;box-shadow:var(--sh);background:#fff}
#sheet svg{display:block}#sheet a{cursor:pointer}#sheet a:hover rect{fill:rgba(37,99,235,.12)}
@media (max-width:640px){nav{display:none}#stage{padding:8px}}
@page{margin:10mm}
@media print{html,body{height:auto;background:#fff}body{display:block}header,nav,#stage{display:none}main{display:block}div[hidden]{display:block}.pg{break-after:page;page-break-after:always}.pg:last-child{break-after:auto;page-break-after:auto}.pg svg{display:block;width:100%;height:auto;break-inside:avoid}}`;

const SCRIPT = `(function(){
var L=JSON.parse(document.getElementById('nb-labels').textContent);
var pg=[].slice.call(document.querySelectorAll('.pg')),N=pg.length,cur=-1,zoom=1,fit=true;
var stage=document.getElementById('stage'),sheet=document.getElementById('sheet'),pos=document.getElementById('pos'),nav=document.getElementById('strip');
var bPrev=document.getElementById('prev'),bNext=document.getElementById('next');
var thumbs=[];
function svgOf(i){return pg[i].svg;}
function dims(i){var v=svgOf(i).viewBox.baseVal;return[v.width,v.height];}
function fitZoom(i){var d=dims(i),w=stage.clientWidth-(stage.clientWidth>640?34:18);return Math.max(.05,w/d[0]);}
function apply(keep){
 var s=svgOf(cur),d=dims(cur);
 var rx=keep&&stage.scrollWidth>stage.clientWidth?(stage.scrollLeft+stage.clientWidth/2)/stage.scrollWidth:.5;
 var ry=keep&&stage.scrollHeight>stage.clientHeight?(stage.scrollTop+stage.clientHeight/2)/stage.scrollHeight:0;
 s.setAttribute('width',d[0]*zoom);s.setAttribute('height',d[1]*zoom);
 if(keep){stage.scrollLeft=rx*stage.scrollWidth-stage.clientWidth/2;stage.scrollTop=ry*stage.scrollHeight-stage.clientHeight/2;}
}
function show(i,top){
 i=Math.max(0,Math.min(N-1,i));
 if(cur>=0){pg[cur].appendChild(svgOf(cur));}
 cur=i;sheet.appendChild(svgOf(cur));
 if(fit)zoom=fitZoom(cur);
 apply(false);if(top!==false){stage.scrollTop=0;stage.scrollLeft=0;}
 pos.textContent=L.page+' '+(cur+1)+' '+L.of+' '+N;
 bPrev.disabled=cur===0;bNext.disabled=cur===N-1;
 thumbs.forEach(function(a,k){if(k===cur){a.setAttribute('aria-current','page');a.scrollIntoView({block:'nearest'});}else a.removeAttribute('aria-current');});
 var h='#p'+(cur+1);if(location.hash!==h)history.replaceState(null,'',h);
}
function setZoom(z,fixed){fit=!!fixed;zoom=Math.max(.1,Math.min(8,z));apply(true);}
function fill(a){
 var ph=a.querySelector('.ph');if(!ph)return;
 var c=svgOf(a.nbi).cloneNode(true);c.removeAttribute('width');c.removeAttribute('height');
 [].forEach.call(c.querySelectorAll('a'),function(x){x.parentNode.removeChild(x);});
 [].forEach.call(c.querySelectorAll('[id]'),function(x){x.removeAttribute('id');});
 a.replaceChild(c,ph);
}
function build(){
 var io=typeof IntersectionObserver==='function'?new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){io.unobserve(en.target);fill(en.target);}});},{root:nav,rootMargin:'300px 0px'}):null;
 for(var i=0;i<N;i++){(function(i){
  var a=document.createElement('a');a.href='#p'+(i+1);a.title=pg[i].getAttribute('data-label')||'';a.nbi=i;
  var d=dims(i),ph=document.createElement('div');ph.className='ph';ph.style.aspectRatio=d[0]+' / '+d[1];
  a.appendChild(ph);a.appendChild(document.createTextNode(String(i+1)));
  a.addEventListener('click',function(e){e.preventDefault();show(i);});
  nav.appendChild(a);thumbs.push(a);if(io)io.observe(a);else fill(a);})(i);}
}
var printing=false;
window.addEventListener('beforeprint',function(){if(cur>=0&&svgOf(cur).parentNode!==pg[cur]){pg[cur].appendChild(svgOf(cur));printing=true;}});
window.addEventListener('afterprint',function(){if(printing){printing=false;sheet.appendChild(svgOf(cur));apply(false);}});
function fromHash(){var m=/^#p(\\d+)$/.exec(location.hash);return m?Number(m[1])-1:0;}
document.getElementById('fit').onclick=function(){fit=true;zoom=fitZoom(cur);apply(false);};
document.getElementById('zin').onclick=function(){setZoom(zoom*1.25);};
document.getElementById('zout').onclick=function(){setZoom(zoom/1.25);};
bPrev.onclick=function(){show(cur-1);};bNext.onclick=function(){show(cur+1);};
sheet.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-go]');if(a){e.preventDefault();show(Number(a.getAttribute('data-go'))-1);}});
window.addEventListener('hashchange',function(){var i=fromHash();if(i!==cur)show(i);});
window.addEventListener('keydown',function(e){
 if(e.ctrlKey||e.metaKey||e.altKey)return;var k=e.key;
 if(k==='ArrowRight'||k==='PageDown'||k==='n'){show(cur+1);e.preventDefault();}
 else if(k==='ArrowLeft'||k==='PageUp'||k==='p'){show(cur-1);e.preventDefault();}
 else if(k==='Home'){show(0);e.preventDefault();}else if(k==='End'){show(N-1);e.preventDefault();}
 else if(k==='+'||k==='='){setZoom(zoom*1.25);e.preventDefault();}else if(k==='-'){setZoom(zoom/1.25);e.preventDefault();}
 else if(k==='0'||k==='f'){document.getElementById('fit').click();e.preventDefault();}
});
stage.addEventListener('wheel',function(e){
 if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();
 var r=stage.getBoundingClientRect(),px=e.clientX-r.left+stage.scrollLeft,py=e.clientY-r.top+stage.scrollTop,old=zoom;
 setZoom(zoom*Math.exp(-e.deltaY*(e.deltaMode?0.05:0.0025)));
 var f=zoom/old;stage.scrollLeft=px*f-(e.clientX-r.left);stage.scrollTop=py*f-(e.clientY-r.top);
},{passive:false});
var ptr={},dist=0,z0=1,drag=null;
stage.addEventListener('pointerdown',function(e){
 ptr[e.pointerId]=[e.clientX,e.clientY];var ids=Object.keys(ptr);
 if(ids.length===2){var a=ptr[ids[0]],b=ptr[ids[1]];dist=Math.hypot(a[0]-b[0],a[1]-b[1]);z0=zoom;drag=null;}
 else if(e.pointerType==='mouse'&&e.button===0&&!(e.target.closest&&e.target.closest('a'))){drag=[e.clientX,e.clientY,stage.scrollLeft,stage.scrollTop];stage.classList.add('drag');}
});
stage.addEventListener('pointermove',function(e){
 if(!ptr[e.pointerId])return;ptr[e.pointerId]=[e.clientX,e.clientY];var ids=Object.keys(ptr);
 if(ids.length===2&&dist>0){var a=ptr[ids[0]],b=ptr[ids[1]];setZoom(z0*Math.hypot(a[0]-b[0],a[1]-b[1])/dist);}
 else if(drag){stage.scrollLeft=drag[2]-(e.clientX-drag[0]);stage.scrollTop=drag[3]-(e.clientY-drag[1]);}
});
function up(e){delete ptr[e.pointerId];dist=0;drag=null;stage.classList.remove('drag');}
stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',up);
var rt=0;window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){if(fit){zoom=fitZoom(cur);apply(false);}},80);});
pg.forEach(function(p){var s=p.querySelector('svg');p.svg=s;s.setAttribute('role','img');s.setAttribute('aria-label',p.getAttribute('data-label')||'');});
build();show(fromHash(),false);
})();`;

/** `<`, `>`, `&` and the line separators made safe inside a JSON script element. */
function jsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The start of the file: everything before the first page. */
export function htmlHead(head: HtmlHead): string {
	const l = head.labels ?? DEFAULT_HTML_LABELS;
	const title = escapeHtml(head.title);
	const btn = (id: string, label: string, glyph: string): string => `<button id="${id}" type="button" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${glyph}</button>`;
	return `<!DOCTYPE html>
<html lang="${escapeAttr(head.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="generator" content="Notebook for Obsidian">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<header>
<h1>${title}</h1>
${btn("prev", l.prev, "&#8249;")}
<span id="pos" aria-live="polite"></span>
${btn("next", l.next, "&#8250;")}
${btn("zout", l.zoomOut, "&#8722;")}
${btn("zin", l.zoomIn, "+")}
<button id="fit" type="button">${escapeHtml(l.fit)}</button>
</header>
<main>
<nav id="strip" aria-label="${escapeAttr(l.pages)}"></nav>
<div id="stage" tabindex="0"><div id="sheet"></div></div>
</main>
<div hidden>
`;
}

/** One page: its SVG (clip ids scoped to the page) with its links. `index` is 0-based. */
export function htmlPage(index: number, count: number, svg: string, label: string, links: readonly HtmlLink[] = []): string {
	let body = scopeSvgIds(svg.trimEnd(), index);
	const tags = linkTags(links, count);
	if (tags && body.endsWith("</svg>")) body = `${body.slice(0, -"</svg>".length)}${tags}</svg>`;
	return `<section class="pg" id="page-${index + 1}" data-label="${escapeAttr(label)}">\n${body}\n</section>\n`;
}

/** The end of the file: the viewer. */
export function htmlTail(labels: HtmlViewerLabels = DEFAULT_HTML_LABELS): string {
	return `</div>
<script type="application/json" id="nb-labels">${jsonForScript(labels)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** The whole file at once (tests and small notebooks; the export writes the same parts one page at a time). */
export function buildHtml(head: HtmlHead, pages: readonly { svg: string; label: string; links?: readonly HtmlLink[] }[]): string {
	const parts = [htmlHead(head)];
	pages.forEach((p, i) => parts.push(htmlPage(i, pages.length, p.svg, p.label, p.links ?? [])));
	parts.push(htmlTail(head.labels));
	return parts.join("");
}
