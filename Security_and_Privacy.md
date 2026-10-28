# Security and Privacy

## 1. Authorisation status: action required

Processing the full register requires a documented legal basis and approval. Under the Nigeria Data Protection Act 2023 and the Electoral Act 2022, a responsible officer must confirm:

- that the copy of the register was lawfully obtained by the party;
- the purpose of processing (data administration, quality checks and aggregate reporting);
- that the retention period and the data controller are defined;
- whether a Data Protection Impact Assessment is required (likely, given the scale of the data).

The worker **refuses a full import** until a person records an attestation:

```
npm run ingest -- authorize --by "<full name>" --reference "<approval document reference>"
```

That step is deliberately left to an authorised person. The development team must not run it on their behalf.

**What has already been processed:** the single pilot ward (80 files, 33,555 pseudonymised records) in the local `lagos_eip_register` database, as part of controlled sample testing. To remove it, drop that database (see Deployment_Guide.md §6).

## 2. Data minimisation (by design)

| Data | Treatment |
|---|---|
| Names | Never stored. Held in memory only during parsing; stored as a keyed hash (HMAC-SHA256) of the normalised name and birth year |
| VINs | Never stored. Stored as keyed hashes; data stewards can check a VIN, which is hashed server-side |
| Photographs | Never decoded or extracted |
| Addresses / phone numbers | Not present in the source |
| Birth year, gender, PU | Stored (needed for aggregates). Combined with the key, this is still **personal data (pseudonymised)** |

The `RECORD_HASH_KEY` is the re-identification key. Store it like a password:
- **Lost:** VIN lookups and duplicate matching against new imports stop working.
- **Leaked:** rotate the key and re-import.

## 3. Access control

| Role | Key permissions | MFA |
|---|---|---|
| System Administrator | Users, configuration, media, audit, imports (read/verify), exports | Required |
| Data Steward | Imports, data-quality decisions, **individual VIN lookup**, exports | Required |
| Executive Viewer | Aggregates, quality summary, exports | Optional |
| Ward Collation Officer | Own ward(s) only: drafts, submissions, attachments | Optional |
| LGA Collation Officer | Own LGA(s) only: review, return, approve, discrepancies, exports | Optional |
| Report Reviewer | Aggregates, quality, collation (read), exports | Required |
| Auditor | Audit log, read-only imports/quality/collation | Required |

- All checks run on the server (`requirePerm`, `assertScope`, `scopeFilter`). Denials are audited.
- No dashboard route returns names, VINs or row-level personal data. Exports are aggregate-only.
- A reviewer cannot approve their own submission.

## 4. Authentication and sessions

- Passwords: scrypt (N=16384). Minimum 12 characters with letters and digits. Admin-issued temporary passwords must be changed at first sign-in, before any data access.
- Accounts lock for 15 minutes after 5 failures. Unknown accounts take the same time to reject as known ones.
- TOTP (RFC 6238, verified against the RFC test vector). Secrets are AES-256-GCM encrypted at rest. Each code can be used only once (replay protection).
- Session cookie is `httpOnly`, `SameSite=Strict`, and `Secure` when `COOKIE_SECURE=true`. Only its SHA-256 hash is stored.
- Sessions expire after 60 minutes idle or 12 hours absolute. Expired sessions are removed by a TTL index.
- Revoking a user, changing a role or scope, resetting a password or resetting MFA ends sessions immediately.

## 5. Application protections

- **Rate limits:** login (per IP and per account), MFA (10 per 5 minutes) and the general API.
- **CSRF:** a custom request header is required on every state-changing call, and CORS is not enabled.
- **Headers:** Helmet with a CSP that allows only `self` plus Cloudinary images.
- **Uploads:** checked by **file content (magic bytes)** rather than the declared type, with per-purpose size limits. SVGs containing script are rejected. Officer documents are stored as Cloudinary `private` and opened through 5-minute signed URLs.
- **Errors:** the API returns generic errors; internal messages are never echoed. Worker errors are sanitised and truncated.
- **CSV exports:** neutralise spreadsheet formula injection.
- **Logging:** the audit log never stores VINs (lookups record only the match count and the stated reason).

## 6. Encryption

- **In transit:** run behind HTTPS (reverse proxy or IIS/ARR) and set `COOKIE_SECURE=true` (Deployment_Guide.md).
  MongoDB listens on 127.0.0.1 only.
- **At rest:** MongoDB Community does not encrypt data files.
  - Enable **BitLocker** on the drive holding the database and on any backup media.
  - MongoDB Enterprise or Atlas encryption at rest are alternatives if the hosting decision allows.
  - TOTP secrets are additionally application-encrypted.

## 7. Files and secrets

- `.gitignore` excludes `DONE/`, `*.pdf`, `*.csv`, dumps, `.env*`, `.venv/` and `.demo-credentials.txt`.
- **The project is not yet a Git repository.** Run `git init` only after confirming the ignore rules (`git status` must not list `DONE/`).
- The restricted folder sits *inside* the project directory. It is excluded from the TypeScript build, the Vite dev server (`fs.deny`) and the watchers. Consider moving it outside the project tree when convenient and updating `SOURCE_DATA_DIR`.
- Cloudinary credentials are server-side only. Nothing is prefixed `VITE_`.

## 8. Known limitations / residual risks

- The rate limiter is in-memory, which is fine for a single server instance. Use a shared store if you scale out.
- The local MongoDB helper has no authentication. It must stay bound to 127.0.0.1. For a pilot, use an installed MongoDB service with auth enabled and least-privilege users (Deployment_Guide.md §3).
- The duplicate rule D2 produces false positives for common names. Findings are candidates and must not be acted on without review.
- Not political-preference inference: the platform does not infer party support or voting intention from voter records, and must not be extended to do so.
