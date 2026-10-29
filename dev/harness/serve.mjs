// Tiny static file server for the built harness (dev only; the page itself needs no server code).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

export function serve(dir, port) {
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
		if (rel.startsWith("..")) {
			res.writeHead(403).end();
			return;
		}
		try {
			const body = await readFile(join(dir, rel));
			res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" });
			res.end(body);
		} catch {
			res.writeHead(404).end("not found");
		}
	});
	server.listen(port, "127.0.0.1", () => console.log(`harness: http://localhost:${server.address().port}/`));
	return server;
}
