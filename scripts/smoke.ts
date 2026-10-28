/** Smoke test against a running server with the synthetic demo database. Prints no secrets. */
import { readFileSync } from 'node:fs';
import { totpAt } from '../server/auth/totp.js';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4000';
const creds = readFileSync('.demo-credentials.txt', 'utf8').split('\n').filter((l) => l.includes('@demo.local')).map((l) => {
  const [role, email, password, , , secret] = l.trim().split(/\s+/);
  return { role, email: email!, password: password!, secret };
});
async function session(email: string) {
  const c = creds.find((x) => x.email === email)!;
  let cookie = '';
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(BASE + path, { ...init, headers: { 'x-eip-request': '1', 'content-type': 'application/json', cookie, ...(init.headers as object) } });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0]!;
    return r;
  };
  const l = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: c.password }) })).json();
  if (l.mfa === 'verify') await call('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ code: totpAt(c.secret!, Date.now()) }) });
  return call;
}
const check = (name: string, ok: boolean, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
const html = await fetch(BASE + '/');
check('SPA served', html.status === 200 && (await html.text()).includes('<div id="root">'));
check('CSP header', !!html.headers.get('content-security-policy'));
for (const p of ['/DONE/', '/.env', '/package.json', '/server/index.ts']) {
  const r = await fetch(BASE + p);
  const t = await r.text();
  check(`not exposed: ${p}`, !t.includes('RECORD_HASH_KEY') && !t.includes('"dependencies"') && !t.includes('import '), `status ${r.status} (SPA fallback is fine)`);
}
check('anonymous API blocked', (await fetch(BASE + '/api/stats/overview')).status === 401);
const exec = await session('executive@demo.local');
const ov = await (await exec('/api/stats/overview')).json();
check('executive overview', ov.metrics?.validatedUnique?.value > 0, `validatedUnique=${ov.metrics?.validatedUnique?.value} synthetic=${ov.dataset?.synthetic}`);
const node = await (await exec('/api/geo/node/24')).json();
check('state = sum of LGAs', node.unit.records === node.children.reduce((a: number, c: { records: number }) => a + c.records, 0), `${node.children.length} LGAs`);
const b = await (await exec('/api/geo/boundaries?level=lga')).json();
check('boundaries served', b.features.length === 20, b.attribution);
const pdf = await exec('/api/reports/executive-summary?format=pdf&scope=24');
check('PDF export', pdf.status === 200 && (await pdf.arrayBuffer()).byteLength > 1000);
const admin = await session('admin@demo.local');
check('admin MFA session works', (await admin('/api/users')).status === 200);
const ward = creds.find((c) => c.role === 'ward_officer')!;
const w = await session(ward.email);
check('ward officer blocked from state', (await w('/api/geo/node/24')).status === 403);
check('ward officer blocked from export', (await w('/api/reports/executive-summary?format=csv&scope=24-11-01')).status === 403);
const lga = await session('lga.ikeja@demo.local');
const st = await (await lga('/api/collation/lga/24-11/status')).json();
check('LGA status board', Array.isArray(st.wards), JSON.stringify(st.counts));
check('LGA officer blocked from other LGA', (await lga('/api/collation/lga/24-01/status')).status === 403);
const steward = await session('steward@demo.local');
const q = await (await steward('/api/stats/quality/summary')).json();
check('quality summary', q.rows.length > 0, `${q.rows.length} category/status rows`);
