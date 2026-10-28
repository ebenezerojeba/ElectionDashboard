# Deployment Guide (Windows, single machine)

## 1. Prerequisites

- Node.js ≥ 20 (tested on 26.8)
- Python 3 (for the pypdf fallback)
- MongoDB 7: either the bundled helper (development) or an installed service (pilot)
- About 15 GB free disk for the full register database, working files and one backup (estimate below)

```powershell
npm install
python -m venv .venv; .venv\Scripts\pip install pypdf==6.1.1 pikepdf
copy .env.example .env      # then generate keys (see comments in the file)
```

## 2. Configuration (`.env`)

| Variable | Notes |
|---|---|
| `MONGODB_URI`, `MONGODB_DB` | Use `lagos_eip_demo` for the synthetic demo and `lagos_eip_register` for real data |
| `RECORD_HASH_KEY`, `APP_ENCRYPTION_KEY` | 64 hex chars each. **Back up securely.** The worker refuses real data with development keys |
| `SOURCE_DATA_DIR` | Restricted folder (currently `./DONE`) |
| `INGEST_MEMORY_LIMIT_MB` | Worker stops safely above this (default 700) |
| `INGEST_PYTHON` | `.venv/Scripts/python.exe` |
| `COOKIE_SECURE` | `true` behind HTTPS |
| `CLOUDINARY_*` | Server-side only |

## 3. Database

**Development:** `npm run db:local` runs the official mongod 7.0.14 binary on 127.0.0.1:27017 with a 0.25 GB cache. Data is stored in `%LOCALAPPDATA%\LagosEIP\mongodb`.

**Pilot:** install MongoDB Community Server as a Windows service, then:

1. Set `net.bindIp: 127.0.0.1` and `security.authorization: enabled`.
2. Set `storage.wiredTiger.engineConfig.cacheSizeGB: 0.5`.
3. Put the data directory on a BitLocker-encrypted drive.
4. Create least-privilege users:
   - `eip_app`: `readWrite` on the target database only (used by the API and worker);
   - `eip_backup`: `backup` role;
   - an admin user kept offline.
5. Set `MONGODB_URI=mongodb://eip_app:<pw>@127.0.0.1:27017/?authSource=<db>`.

## 4. Synthetic demonstration

```powershell
$env:MONGODB_DB='lagos_eip_demo'
npm run seed:demo            # ~130k synthetic records through the real pipeline; writes .demo-credentials.txt
npm run boundaries:import    # GRID3 LGA polygons
npm run build
$env:NODE_ENV='production'; npm start     # http://127.0.0.1:4000
```

Privileged demo accounts have TOTP secrets listed in `.demo-credentials.txt`; add them to an authenticator app. Delete the file after the demonstration.

For development with hot reload, run `npm run dev:api` and `npm run dev:web` (http://127.0.0.1:5173).

## 5. Real register import (in order — do not skip)

```powershell
$env:MONGODB_DB='lagos_eip_register'
npm run ingest -- catalog                                   # metadata only
npm run ingest -- pilot --prefix "01_AGEGE/01_ISALE_IDIMANGORO/"
npm run ingest -- verify                                    # must show pusUnbalanced = 0
npm run ingest -- estimate                                  # must show sufficient: true
npm run ingest -- authorize --by "<name>" --reference "<ref>"   # authorised officer only
npm run ingest -- run                                       # full import (~1.3 h measured)
npm run ingest -- verify
npm run boundaries:import
npm run user:create -- --email <admin> --name "<name>" --role system_admin
```

- **Interrupting:** Ctrl+C finishes the current file and stops. Resume with `npm run ingest -- run --resume <jobId>`, or simply start `run` again. Completed files are skipped and nothing duplicates.
- **Failed files:** `npm run ingest -- retry-failed`, then `run` again.

### Storage estimate (measured on the pilot)

| Item | Value |
|---|---|
| Upper-bound rows (all copies) | ~7.87 M |
| Bytes per stored record (data + indexes) | 401 |
| Database upper bound | ~2.9 GB |
| Required free space (×2.5 + 5 GB margin) | ~12.4 GB |
| Free at time of measurement | 39.5 GB |

## 6. Backup, restore and rollback

- **Backup:** use MongoDB Database Tools. Write `mongodump --db lagos_eip_register --gzip --archive=<encrypted drive>\eip_YYYYMMDD.gz`. Never store backups in the project folder or in Cloudinary.
- **Restore:** `mongorestore --gzip --archive=<file> --nsInclude "lagos_eip_register.*" --drop`.
- **Undo an import job:** the source PDFs are never modified, so the safe rollback is to drop and rebuild:
  1. drop the `voter_records`, `ingest_rejects`, `source_files`, `import_jobs`, `agg_geo` and `dq_issues` collections (or the whole database);
  2. run `catalog`, `pilot` and `run` again.

  Users, the audit log and collation data live in the same database, so dump them first if you drop the whole database.
- **Remove the pilot data:** `mongosh lagos_eip_register --eval "db.dropDatabase()"`.

## 7. HTTPS

Expose the API only through a TLS-terminating reverse proxy (for example Caddy or IIS with ARR) on the institution's network. Then:

- set `NODE_ENV=production` and `COOKIE_SECURE=true`;
- keep the Node server bound to 127.0.0.1;
- the API trusts one proxy hop in production for client IPs.

## 8. Cloudinary usage estimate

The only uploads are branding images (a few MB) and officer supporting documents (≤10 MB each, at most 5 per ward report). For 245 wards with two documents each, that is under 5 GB per exercise, well within paid plan limits. Bandwidth is negligible: documents are fetched on demand through signed URLs.
