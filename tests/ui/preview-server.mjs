import '../../scripts/test-bootstrap.mjs';
// Interactive UI preview: the real renderer against a real Engine on a COPY of a data directory.
// Adapters are offline (no model calls, no logins); main-process methods are stubbed.
//   node --import tsx tests/ui/preview-server.mjs --data <copied data dir> [--port 5390]
// Open http://127.0.0.1:<port>/ in a browser. Never point --data at the live daily data directory.
import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from '../../scripts/ui-test-server.mjs';
import { Engine } from '../../src/backend/engine';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i > 0 ? process.argv[i + 1] : fallback; };
const data = path.resolve(arg('--data', ''));
const port = Number(arg('--port', '5390'));
if (!existsSync(path.join(data, 'airoom.sqlite'))) throw new Error('--data must be a copied AIROOM data directory');
if (/[\\/]\.airoom[\\/]data$/i.test(data)) throw new Error('refusing to open the live daily data directory');

const offline = id => ({
  probe: async () => ({ id, name: id, available: true, auth: id === 'dsh' ? 'account' : 'subscription', detail: 'UI preview (offline)', capabilities: { steer: id === 'codex', cancel: 'native', streaming: true, write: true, history: true, images: true } }),
  start: async () => { throw new Error('预览环境不调用模型。'); },
  stop: async () => {},
});
const clients = new Set();
const send = event => { const line = `data: ${JSON.stringify(event)}\n\n`; for (const res of clients) res.write(line); };
const engine = new Engine(data, event => send(event?.type === 'snapshot' ? { ...event, snapshot: { ...event.snapshot, backendReady: true } } : event), () => {}, offline);
await engine.probe();

const stubs = {
  'app.version': () => ({ version: 'preview' }), 'window.attention': () => ({}), 'window.show': () => ({}), 'renderer.error': () => ({}),
  'file.save': () => ({ saved: false }), 'dialog.directory': () => null, 'dialog.program': () => null, 'attachment.pick': () => [],
  'project.openPath': () => ({ opened: false }), 'workspace.open': () => ({ opened: false }), 'artifact.open': () => ({ opened: false }),
  'desk.folder': () => ({ opened: false }), 'backup.create': () => ({}), 'backup.prepare': () => ({}), 'backup.cancel': () => ({}),
  'all.stop': () => ({}), 'backend.restart': () => ({}), 'catalog.openLink': () => ({}), 'executor.openLogin': () => ({}),
};
async function rpc(method, params) {
  if (stubs[method]) return stubs[method](params);
  const result = await engine.invoke(method, params);
  return method === 'snapshot' ? { ...result, backendReady: true } : result;
}

const bridge = `
<script>
(() => {
  const listeners = new Set();
  const source = new EventSource('/__events');
  source.onmessage = message => { const event = JSON.parse(message.data); for (const fn of listeners) fn(event); };
  window.airoom = {
    invoke: async (method, params) => {
      const response = await fetch('/__rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
      const body = await response.json(); if (body.error) throw new Error(body.error); return body.result;
    },
    pathForFile: () => '',
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  // airoom-asset://local/<file> is served by Electron; the preview serves the copy under /__asset/.
  const fix = value => typeof value === 'string' && value.includes('airoom-asset://local/') ? value.replaceAll('airoom-asset://local/', '/__asset/') : value;
  const rewrite = node => {
    if (node.nodeType !== 1) return;
    for (const el of [node, ...node.querySelectorAll('[src],[style]')]) {
      const src = el.getAttribute && el.getAttribute('src'); if (src && fix(src) !== src) el.setAttribute('src', fix(src));
      const style = el.getAttribute && el.getAttribute('style'); if (style && fix(style) !== style) el.setAttribute('style', fix(style));
    }
  };
  new MutationObserver(records => { for (const r of records) { if (r.type === 'attributes') rewrite(r.target); else r.addedNodes.forEach(rewrite); } })
    .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });
})();
</script>`;

const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: 'warn', server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [{
    name: 'airoom-preview-bridge',
    transformIndexHtml: html => html.replace('<head>', '<head>' + bridge),
    configureServer(vite) {
      vite.middlewares.use('/__events', (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        clients.add(res); req.on('close', () => clients.delete(res));
      });
      vite.middlewares.use('/__rpc', (req, res) => {
        let body = ''; req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          res.setHeader('content-type', 'application/json');
          try { const { method, params } = JSON.parse(body); res.end(JSON.stringify({ result: (await rpc(method, params)) ?? null })); }
          catch (error) { res.end(JSON.stringify({ error: error?.message ?? String(error) })); }
        });
      });
      vite.middlewares.use('/__asset', (req, res) => {
        // Same layout as main.ts: attachments/<id>/<name>, everything else under assets/.
        const name = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
        const file = path.resolve(data, name.startsWith('attachments/') ? name : path.join('assets', name));
        if (!file.startsWith(data + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
        createReadStream(file).pipe(res);
      });
    },
  }],
});
await server.listen();
console.log(`AIROOM UI preview: http://127.0.0.1:${port}/  (data copy: ${data})`);
const shutdown = async () => { await server.close(); await engine.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
