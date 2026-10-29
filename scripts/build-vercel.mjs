/**
 * Assembles a Vercel "prebuilt" deployment (Build Output API v3) in .vercel/output.
 * Only the built web app and the traced server files are included, so the restricted
 * source folder, .env files and credentials can never be uploaded.
 *
 *   npm run build && node scripts/build-vercel.mjs && npx vercel deploy --prebuilt --prod
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.vercel', 'output');
const func = path.join(out, 'functions', 'api.func');
const entry = path.join(root, 'dist', 'server', 'vercel.js');
if (!existsSync(entry) || !existsSync(path.join(root, 'dist', 'web', 'index.html'))) {
  console.error('Run "npm run build" first.');
  process.exit(1);
}

// Never ship these, whatever the tracer finds.
// Checked against project files; library code under node_modules is only checked for PDFs.
const FORBIDDEN = [/^DONE[\\/]/i, /^\.env/i, /\.pdf$/i, /^\.(demo|pitch)-credentials/i, /^\.venv[\\/]/i, /^pitch[\\/]/i, /^reference[\\/]/i, /\.(bson|archive|csv)$/i];
const isRestricted = (rel) => (/^node_modules[\\/]/.test(rel) ? /\.pdf$/i.test(rel) : FORBIDDEN.some((re) => re.test(rel)));

rmSync(out, { recursive: true, force: true });
mkdirSync(func, { recursive: true });

// 1. Static web app
cpSync(path.join(root, 'dist', 'web'), path.join(out, 'static'), { recursive: true });

// 2. Serverless function with exactly the files the server needs
const { fileList } = await nodeFileTrace([entry], { base: root, processCwd: root });
// The tracer can miss files that packages load conditionally (export conditions differ by Node
// version), so every traced package is shipped whole.
const files = new Set([...fileList].filter((f) => !/^node_modules[\\/]/.test(f)));
const pkgRoots = new Set();
for (const f of fileList) {
  const m = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(f);
  if (m) pkgRoots.add(m[1]);
}
const { readdirSync, statSync } = await import('node:fs');
const walk = (dir) => {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (name === 'node_modules') continue; // nested deps are their own package roots
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
    else files.add(rel);
  }
};
for (const p of pkgRoots) walk(p);
let copied = 0;
for (const rel of [...files].sort()) {
  if (isRestricted(rel)) {
    console.error(`Refusing to include restricted file: ${rel}`);
    process.exit(1);
  }
  const src = path.join(root, rel);
  const dst = path.join(func, rel);
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { dereference: true });
  copied++;
}
writeFileSync(
  path.join(func, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'dist/server/vercel.js', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60, supportsResponseStreaming: false }, null, 2),
);

// 3. Routing + security headers for static files
const security = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
writeFileSync(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '/(.*)', headers: security, continue: true },
        { src: '/api/(.*)', dest: '/api' },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);
console.log(`Vercel output ready: ${copied} server files traced, static site copied → ${path.relative(root, out)}`);
