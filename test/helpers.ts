import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = new URL('./fixtures/site/', import.meta.url).pathname;

/** Minimal static server: /shop -> shop/index.html */
export async function serveFixtures(): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    if (!extname(p)) p = join(p, 'index.html');
    try {
      const body = await readFile(join(ROOT, p));
      res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>404</title>');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, server };
}
