/**
 * Turns on "Check registration" for the live site. Run it yourself from the project folder:
 *
 *   node scripts/enable-online-lookup.mjs
 *
 * It does three things, in order:
 *   1. Uploads the compact name-fingerprint index to Atlas (no names or VINs; about 120 MB).
 *   2. Gives Vercel the same RECORD_HASH_KEY as this machine, so typed names match the fingerprints.
 *   3. Rebuilds and redeploys the live site.
 *
 * Needs: local MongoDB running (npm run db:local), .env.cloud filled in, and being signed in to Vercel.
 */
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, opts = {}) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};

console.log('Step 1 of 3: uploading the registration index to Atlas (takes 15–25 minutes)…');
run('npx tsx scripts/publish-name-index.ts');

console.log('\nStep 2 of 3: giving Vercel the matching key…');
const key = /^RECORD_HASH_KEY=(.*)$/m.exec(readFileSync('.env', 'utf8'))?.[1]?.trim();
if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
  console.error('RECORD_HASH_KEY not found in .env');
  process.exit(1);
}
const r = spawnSync('npx', ['--yes', 'vercel@48.2.0', 'env', 'add', 'RECORD_HASH_KEY', 'production', '--force'], { input: key, stdio: ['pipe', 'ignore', 'inherit'], shell: true });
if (r.status !== 0) {
  console.error('Could not set RECORD_HASH_KEY in Vercel.');
  process.exit(1);
}
console.log('RECORD_HASH_KEY set in Vercel (value not shown).');

console.log('\nStep 3 of 3: rebuilding and redeploying…');
run('npm run build');
run('node scripts/build-vercel.mjs');
run('npx --yes vercel@48.2.0 deploy --prebuilt --prod --yes');
console.log('\nDone. Sign in to the live site as a data steward and open "Check registration".');
