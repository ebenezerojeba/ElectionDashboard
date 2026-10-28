# Testing Report

Date: 2026-10-26. Environment: Windows 10, i5-8365U, 7.8 GB RAM (about 0.5 GB free at the start), Node 26.8, MongoDB 7.0.14.

## 1. Automated tests: 53 passed, 0 failed (`npm test`)

All tests use synthetic data and an in-memory MongoDB. No real register data is used in tests.

| Suite | Tests | Covers |
|---|---|---|
| `test/parser.test.ts` | 13 | Cover parsing (wrapped PU name); record parsing and reconciliation; wrapped VIN plus birth-year text; 18–20 character VINs; malformed/missing VIN rejection; birth-year and gender warnings; footer code mismatch; serial gaps; name normalisation; filename patterns; PDF line assembly |
| `test/ingest.test.ts` | 10 | Import + aggregate accuracy; no personal values stored; both copies loaded in either order without duplicates, gender from the default copy only; alphabetical-only, so gender unavailable; **crash mid-file recovery without duplicates**; refusal while another worker is alive; **memory-limit stop and resume**; unreadable files isolated with no tight retry loop; count mismatch and duplicate VIN detection; issue auto-resolve with history; changed-file detection |
| `test/api.test.ts` | 30 | TOTP RFC vector and replay rejection; generic login failure plus audit; CSRF header; lockout; mandatory MFA enrolment before data access; encrypted MFA secret; session expiry and hashed tokens; immediate revocation; role/scope validation; **state = sum of LGAs = pipeline total**; **ward and LGA geographic restrictions on the server**; pagination and sort consistency plus limit cap; steward-only lookup, no names, VIN not logged; template validation; full ward → LGA workflow (draft, invalid, stale version, submit/receipt, return, resubmit, discrepancy, approve, consolidated totals, history); self-review block; content-based upload validation; CSV/XLSX/PDF exports with all required metadata; export denials logged; CSV formula-injection neutralised; audit-log access and filters; clean error responses (404/400/413/401) |

`npm run typecheck`: clean. `npm run build`: server and web build successfully.

## 2. Real-data pilot (controlled sample)

| Check | Result |
|---|---|
| Redacting probes on sample files (counts and masked shapes only) | Layout confirmed; no personal values printed |
| Two copies compared record-by-record (2 PUs) | 100% match on VIN, name and birth year; gender differs (A-Z copy all "M") |
| pdfjs vs pypdf output (after parser fix) | Identical records (757/757, 756/756) |
| Pilot ward, 80 files | 58/58 PUs balanced; 33,555 unique = 33,555 cover total; 0 rejected |
| **Recovery test:** hard kill (`Stop-Process -Force`) after 46 files, then resume | 1 interrupted file recovered; job completed; reconciliation still balanced (no duplicates) |
| Damaged PDF | pdfjs failed on all pages; pypdf fallback recovered it completely (445 records, balanced) |
| Memory | Peak RSS 487 MB (limit 700 MB) |
| Speed | 346 ms per file on average → about 1.3 h for all 13,974 files |

## 3. End-to-end checks against the production build (`scripts/smoke.ts`): 17/17 passed

The checks ran against the server on the synthetic demo database:

- the SPA is served with a CSP header;
- `/DONE/`, `/.env`, `/package.json` and `/server/*` are not exposed;
- anonymous API calls return 401;
- the overview works; state total equals the sum of the 20 LGAs;
- boundaries are served with attribution;
- PDF export works; an admin session with TOTP works;
- a ward officer is blocked from state data and exports;
- the LGA status board works, and an LGA officer is blocked from other LGAs;
- the data-quality summary works.

## 4. Visual review (`scripts/screenshots.ts`, headless Edge)

Reviewed: login, dashboard (light and dark), explorer (map and table, LGA drill-down), data quality, imports, LGA workspace, ward workspace, reports, users, audit, and the dashboard at 390 px width.

| Defect found | Fix |
|---|---|
| Map blank: MapLibre CSS overrode container positioning | Inline positioning |
| Map uncoloured / not fitted: readiness check and layout timing | Own ready flag plus resize-aware fit |
| Toolbar selects stretched full width | Class conflict fixed |
| Read-only fields looked editable | Disabled styling |
| Raw category codes shown as labels | Proper labels |
| Synthetic data unrealistic (5,039 false "possible duplicates"; age skew) | Generator improved; D2 now flags only the injected case |

## 5. Synthetic demo reconciliation

The demo has 132,702 validated records across 438 files, with injected defects. Every defect is detected:

- 1 unreadable file → `FILE_UNREADABLE`, and its PU is "not fully processed";
- 1 cover total inflated by 2 → `COUNT_MISMATCH`;
- 1 malformed VIN → rejected and `ROWS_REJECTED`; the PU still balances;
- 1 VIN in two PUs → 2 `DUPLICATE_VIN_ACROSS_PUS`;
- 1 same name and birth year with a new VIN → `POSSIBLE_DUPLICATE_REGISTRATION`;
- 1 implausible birth year → `BIRTH_YEAR_IMPLAUSIBLE`;
- alphabetical-only PUs → `GENDER_UNAVAILABLE`.

416 PUs balance.

## 6. Platform audit (2026-10-27)

| Finding | Action |
|---|---|
| **Bug:** login and MFA rate limiters were re-created per request, so they never accumulated (account lockout still protected accounts) | Fixed; limiters created once. Test: 3rd attempt returns 429 |
| Malformed JSON returned 500 | Now 400 `bad_json`. Tested |
| Admin-issued temporary passwords could be kept indefinitely | Users must set their own password before any data access. Tested |
| Damaged PDFs: 2 of the first ~5,500 failed both readers | Added qpdf repair (pikepdf) in memory; recovered 1 of 2. The other has no page tree (needs a fresh copy) |
| Name + birth-year matches (rule D2) would number ~100k+ at full scale, mostly common names | Kept as "for manual review" but excluded from the high-confidence audit total and the executive headline. Tested |
| ~25% of records have no usable gender (alphabetical-only copies) | Gender now also shown as the split among known records |
| Technical tiles (raw rows incl. duplicate copies) confused the executive view | Shown only to data stewards/admins |

## 7. Not yet tested

- Full 13,974-file import: blocked pending authorisation (by design).
- Query performance at full scale (about 7 M records). The pilot shows sub-second aggregate reads, because dashboards read precomputed `agg_geo`. `verify` runtime at full scale still needs measuring.
- Cloudinary uploads against the real account: no credentials are configured yet. The upload path is unit-tested with a fake service.
- Browser support beyond Edge/Chromium; a screen-reader pass.
