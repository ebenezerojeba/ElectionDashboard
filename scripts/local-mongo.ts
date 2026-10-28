/**
 * Development/pilot helper: runs a local, persistent MongoDB server using the official
 * mongod binary (downloaded once by mongodb-memory-server's binary manager).
 *
 * - Listens on 127.0.0.1 only.
 * - Data directory is OUTSIDE the project (default %LOCALAPPDATA%\LagosEIP\mongodb).
 * - WiredTiger cache is capped (default 0.25 GB) for low-RAM machines.
 *
 * For a pilot deployment prefer an installed MongoDB service with authentication enabled
 * (see Deployment_Guide.md). This helper does not enable auth and must never be exposed.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MongoBinary } from 'mongodb-memory-server-core';

const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share');
const dbPath = process.env.LOCAL_MONGO_DBPATH ?? path.join(base, 'LagosEIP', 'mongodb');
const port = process.env.LOCAL_MONGO_PORT ?? '27017';
const cacheGb = process.env.LOCAL_MONGO_CACHE_GB ?? '0.25';
const version = process.env.LOCAL_MONGO_VERSION ?? '7.0.14';

mkdirSync(dbPath, { recursive: true });
console.log(`[local-mongo] resolving mongod ${version} binary (first run downloads ~100 MB)…`);
const bin = await MongoBinary.getPath({ version });
console.log(`[local-mongo] dbPath=${dbPath} port=${port} cacheGB=${cacheGb}`);

const child = spawn(
  bin,
  ['--dbpath', dbPath, '--port', port, '--bind_ip', '127.0.0.1', '--wiredTigerCacheSizeGB', cacheGb, '--quiet', '--logpath', path.join(dbPath, 'mongod.log'), '--logappend'],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => {
  console.log(`[local-mongo] mongod exited with code ${code}`);
  process.exit(code ?? 0);
});
