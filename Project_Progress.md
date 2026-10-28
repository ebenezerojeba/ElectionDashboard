# Project Progress

## Status: 2026-10-26

| Milestone | Status |
|---|---|
| 0. Inspection (project, hardware, source data) | ✅ Done |
| 1. Data foundation: parser, resumable ingestion, verification, data-quality rules, pilot + recovery test | ✅ Done |
| 2. Secure API: auth + MFA, RBAC, geographic scope, audit, stats, quality, collation, reports, media | ✅ Done |
| 3. Web application + synthetic demo + LGA boundaries | ✅ Done |
| 4. Full register import | 🔄 Running (authorisation recorded 2026-10-27 by the account holder; formal approval reference still to be added) |
| 4b. Pitch additions: register audit, field operations planner, situation room + simulator, executive brief | ✅ Done |
| 4c. Platform audit fixes (rate limiter bug, forced password change, PDF repair, audit confidence) | ✅ Done |
| 5. Pilot hardening: MongoDB service with auth, HTTPS, BitLocker, backups, Cloudinary credentials, Git repository | ⏳ Next |

## Inspection findings

- **Project:** the folder was empty apart from the source data (greenfield). It is not a Git repository.
- **Source:** 13,974 text-layer PDFs, not a CSV (see Architecture.md §1). 20 LGAs, 245 wards, 13,232 PU keys.
- **Hardware:** 7.8 GB RAM (about 0.5 GB free when inspected), 40 GB free disk, MongoDB not installed (now run through the bundled helper).
- **Main risks found:** double counting from duplicate copies; unreliable gender in alphabetical copies; damaged PDFs; low free RAM; the restricted data folder sitting inside the project directory.

## Decisions taken

1. **Pseudonymise, don't store identities.** Names and VINs are stored only as keyed hashes; photos are never extracted.
2. **Deterministic record ids** (HMAC of PU + VIN) make imports idempotent and crash-safe.
3. **Gender only from default copies.** Alphabetical-only PUs report gender as unavailable.
4. **Lightweight stack** (Express + Vite) instead of Next.js, for the low-RAM machine. The worker runs as a separate process.
5. **pypdf fallback** for damaged PDFs, chosen per file and recorded.
6. **Separate databases** for synthetic and real data, with guards in both directions.
7. **LGA polygons from GRID3 2022 (CC BY 4.0).** Wards and PUs are shown as tables until verified boundaries exist.

## Open items / decisions needed from the client

1. **Authorisation:** record the attestation (Security_and_Privacy.md §1), then run the full import.
2. **MongoDB for the pilot:** install MongoDB Community as a service with auth (recommended), or provide an alternative.
3. **Cloudinary credentials:** add them to `.env` to enable branding and document uploads.
4. **Collation form:** the default "Ward Situation Report" template is a placeholder. Confirm the authorised reporting structure.
5. **Ward/PU boundaries or coordinates:** supply them from an authorised source if maps below LGA level are required.
6. **Git:** initialise the repository after reviewing `.gitignore`.
7. Consider moving `DONE/` outside the project tree.
