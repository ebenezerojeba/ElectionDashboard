# Data Dictionary

## 1. Source: INEC Display Register PDFs (`DONE/`)

Inspected with redacting probes only. No personal values were printed or logged.

### Cover page (page 1)

| Label | Example shape | Used for |
|---|---|---|
| `Valid Registrations[: (A-Z)]` | — | Copy type (alphabetical vs default) |
| `State` | LAGOS | Check |
| `LGA` | text | LGA name (geographic reference) |
| `Ward` | text | Ward / registration-area name |
| `PU` | text, may wrap | Polling-unit name |
| `Delim` | `24-01-01-001` | **Authoritative PU code** (state-LGA-ward-PU) |
| `Printed` | dd-mm-yyyy | Reporting period / age reference year |
| `Records` | integer | **Reconciliation total** |
| `Pages` | integer | Informational (may differ from the PDF page count; trailing blank pages exist) |

### Data pages (one cell per voter, about 34 per page)

| Field | Format | Stored? |
|---|---|---|
| Serial | integer, sequential per file | Yes, as the source pointer (`src.s`) |
| Name | `SURNAME, OTHER NAMES` (may wrap; hyphen continues a word) | **No.** Only HMAC(normalised name‖birth year) |
| VIN | 18–20 alphanumerics; may wrap onto the next line | **No.** Only HMAC(VIN) and HMAC(PU‖VIN) |
| DOB-Y | yyyy | Yes (`by`) |
| Gender | M/F | Yes (`g`), **default copy only** |
| Footer DELIM | PU code | Validation against the cover |
| Photograph | image | **Never extracted** |

## 2. Stored fields

### `voter_records` (restricted)

| Field | Type | Definition |
|---|---|---|
| `_id` | string(32) | HMAC-SHA256(key, `rec|PU|VIN`), truncated to 16 bytes. Deterministic, so imports are idempotent |
| `pu`, `ward`, `lga` | string | Codes derived from the printed PU code |
| `vh` | string(32) | HMAC(`vin|VIN`): duplicate rule D1 and steward lookup |
| `nk` | string(32) | HMAC(`name|sorted uppercase name tokens|birth year`): duplicate rule D2 |
| `by` | int or null | Birth year |
| `g` | 'M', 'F' or null | Gender from the default copy; null when only the alphabetical copy exists |
| `cp` | ['d','a'] | Which copies contained the entry |
| `src` | {f, p, s} | Source file key, 0-based page, serial |
| `job`, `at` | ObjectId, Date | First job that inserted the record |

### `agg_geo` (aggregates)

| Field | Definition |
|---|---|
| `records` | Validated unique records in the area |
| `expected` | Sum of cover totals for completely processed PUs |
| `rejected` | Rejected rows in the preferred copy |
| `male`, `female`, `genderUnknown` | Gender split ("unknown" = alphabetical-only PUs) |
| `ageBands` | 18-24, 25-34, 35-44, 45-54, 55-64, 65+, unknown (reference year = register print year) |
| `dupVinRecords` | Records whose VIN appears in another PU |
| `pus`, `pusWithData`, `pusComplete` | PU counts: catalogued, with records, fully processed |

## 3. Metric definitions (shown in the UI and reports)

| Metric | Definition |
|---|---|
| Source rows read | Every row read from every processed file, **including second copies**. Not a count of people |
| Register entries (cover totals) | Sum of printed totals, one copy per completely processed PU |
| Validated unique records | Distinct (PU, VIN) entries stored. Never inflated by duplicate files |
| Rejected rows | Rows in the preferred copy that failed validation (missing/malformed VIN, missing name) |
| Duplicate VIN candidates | Records whose VIN also appears in another PU (rule D1) |
| Possible duplicate registrations | Groups sharing name + birth year with different VINs in one ward (rule D2); candidates only |
| Gender unavailable | Records from alphabetical-only PUs |
| Geographic coverage | PUs with at least one validated record, of the PUs in the catalogue |

## 4. Validation rules

| Rule | Result |
|---|---|
| VIN missing | Row rejected (`RECORD_MISSING_VIN`) |
| VIN not 18–20 alphanumerics | Row rejected (`RECORD_MALFORMED_VIN`) |
| Name missing | Row rejected (`RECORD_MISSING_NAME`) |
| Age < 18 or > 120 / no birth year | Kept; warning (`RECORD_INVALID_BIRTH_YEAR`) |
| Gender not M/F | Kept; gender null (`RECORD_INVALID_GENDER`) |
| Footer PU code ≠ cover | File-level issue (`RECORD_PU_MISMATCH`) |
| Serial gap | File-level issue (`SERIAL_GAP`) |

## 5. Pilot measurements (real register, one ward)

Pilot ward: `01_AGEGE/01_ISALE_IDIMANGORO`, 80 files.

| Measure | Value |
|---|---|
| Files | 80 done, 0 failed (1 recovered via the pypdf fallback) |
| Source rows read (all copies) | 48,111 |
| Validated unique records | 33,555 |
| Register cover totals | 33,555 |
| Rejected rows | 0 |
| PUs balanced | 58 / 58 |
| Birth-year warnings | 3 |
| Gender: M / F / unavailable | 9,158 / 7,194 / 17,203 |
| Possible duplicate groups (D2) | 281 (candidates; needs review) |
| Mean time per file | 346 ms |
| Peak worker memory | 487 MB |
| Storage per record (data + indexes) | 401 bytes |
