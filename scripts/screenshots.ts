/**
 * Visual check: signs in as demo users (synthetic database only) and screenshots key pages
 * using headless Edge/Chrome over the DevTools protocol. Output goes to OUT_DIR.
 *
 *   OUT_DIR=<folder> npx tsx scripts/screenshots.ts
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { totpAt } from '../server/auth/totp.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4000';
const OUT = process.env.OUT_DIR ?? path.join(os.tmpdir(), 'eip-shots');
const BROWSER = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
mkdirSync(OUT, { recursive: true });

const creds = readFileSync(process.env.CREDS_FILE ?? '.demo-credentials.txt', 'utf8').split('\n').filter((l) => /@(demo|pitch)\.local/.test(l)).map((l) => {
  const [role, email, password, , , secret] = l.trim().split(/\s+/);
  return { role: role!, email: email!, password: password!, secret };
});

async function loginCookie(email: string): Promise<string> {
  const c = creds.find((x) => x.email === email)!;
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'x-eip-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email, password: c.password }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  const j = await r.json();
  if (j.mfa === 'verify') await fetch(BASE + '/api/auth/mfa/verify', { method: 'POST', headers: { 'x-eip-request': '1', 'content-type': 'application/json', cookie }, body: JSON.stringify({ code: totpAt(c.secret!, Date.now()) }) });
  return cookie.split('=')[1]!;
}

const port = 9333;
const profile = mkdtempSync(path.join(os.tmpdir(), 'eip-browser-'));
const browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = '';
for (let i = 0; i < 40 && !wsUrl; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
  } catch {
    /* not ready */
  }
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.method === 'Runtime.exceptionThrown') console.log('  [page exception]', m.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) console.log(`  [console.${m.params.type}]`, m.params.args?.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' ').slice(0, 300));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') console.log('  [log]', m.params.entry.text?.slice(0, 300));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m.result);
    pending.delete(m.id);
  }
});
const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
await send('Log.enable');

async function shot(name: string, url: string, opts: { width?: number; dark?: boolean; full?: boolean; wait?: number } = {}) {
  const width = opts.width ?? 1440;
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }] });
  await send('Page.navigate', { url: BASE + url });
  await new Promise((r) => setTimeout(r, opts.wait ?? 2500));
  const metrics = await send('Page.getLayoutMetrics');
  const h = Math.min(4000, Math.ceil(metrics.cssContentSize?.height ?? 900));
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: opts.full !== false, clip: { x: 0, y: 0, width, height: opts.full === false ? 900 : h, scale: 1 } });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  console.log('saved', name);
}
async function as(email: string | null) {
  await send('Network.clearBrowserCookies');
  if (email) await send('Network.setCookie', { name: 'eip_sid', value: await loginCookie(email), domain: '127.0.0.1', path: '/', httpOnly: true });
}

const which = (process.env.SHOTS ?? 'all').split(',');
const want = (n: string) => which.includes('all') || which.includes(n);
if (want('login')) { await as(null); await shot('01-login', '/'); }
if (want('dashboard')) { await as('executive@demo.local'); await shot('02-dashboard', '/'); }
if (want('dashboard-dark')) { await as('executive@demo.local'); await shot('02b-dashboard-dark', '/', { dark: true }); }
if (want('explorer')) { await as('executive@demo.local'); await shot('03-explorer-state', '/explorer', { wait: 4000 }); await shot('04-explorer-lga', '/explorer?code=24-11'); }
if (want('quality')) { await as('steward@demo.local'); await shot('05-quality', '/quality'); await shot('06-imports', '/imports'); }
if (want('collation')) { await as('lga.ikeja@demo.local'); await shot('07-lga-workspace', '/collation/lga'); const w = creds.find((c) => c.role === 'ward_officer')!; await as(w.email); await shot('08-ward-workspace', '/collation/ward'); }
if (want('reports')) { await as('admin@demo.local'); await shot('09-reports', '/reports'); await shot('10-users', '/users'); await shot('11-audit', '/audit'); }
if (want('new')) { await as('executive@demo.local'); await shot('13-situation', '/situation', { wait: 5000 }); await shot('15-operations', '/operations', { wait: 3500 }); await as('steward@demo.local'); await shot('14-register-audit', '/audit-register', { wait: 3500 }); }
if (want('real')) { await as('executive@pitch.local'); await shot('real-dashboard', '/', { full: false, wait: 12000 }); await shot('real-explorer', '/explorer', { full: false, wait: 9000 }); await shot('real-operations', '/operations', { full: false, wait: 4000 }); }
if (want('style')) { await as('executive@pitch.local'); await shot('s-dashboard', '/', { full: false, wait: 9000 }); await shot('s-explorer', '/explorer', { full: false, wait: 9000 }); await shot('s-situation', '/situation', { full: true, wait: 9000 }); }
if (want('districts')) { await as('executive@pitch.local'); await shot('d-explorer', '/explorer?view=district', { full: false, wait: 9000 }); await as('steward@pitch.local'); await shot('d-lookup', '/lookup', { full: false, wait: 4000 }); }
if (want('mobile')) { await as('executive@demo.local'); await shot('12-mobile-dashboard', '/', { width: 390 }); }
if (process.env.EVAL) { await as('executive@demo.local'); await send('Page.navigate', { url: BASE + '/explorer' }); await new Promise((r) => setTimeout(r, 5000)); const r = await send('Runtime.evaluate', { expression: process.env.EVAL, returnByValue: true }); console.log('EVAL', JSON.stringify(r.result?.value ?? r)); }
ws.close();
browser.kill();
