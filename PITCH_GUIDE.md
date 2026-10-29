# Pitch Guide

A 15–20 minute walkthrough for party leadership.

## Before the meeting (10 minutes)

Open three PowerShell windows in the project folder:

```powershell
# 1. Database
npm run db:local

# 2. Real-data dashboard (port 4001)
$env:NODE_ENV='production'; $env:MONGODB_DB='lagos_eip_register'; $env:PORT='4001'; node dist/server/index.js

# 3. Demo dashboard (port 4000): collation workflow + situation room
$env:NODE_ENV='production'; $env:MONGODB_DB='lagos_eip_demo'; node dist/server/index.js
```

Then:

- Sign in to http://127.0.0.1:4001 as `executive@pitch.local` (password in `.pitch-credentials.txt`).
- In a second browser window, sign in to http://127.0.0.1:4000 as `executive@demo.local` (password in `.demo-credentials.txt`) and open **Situation room**.
- Plug in the laptop, close other apps, turn off notifications and set the display to "Extend" for a TV.
- Have the **Executive Brief PDF** printed as a leave-behind: `pitch/Executive_Brief_Lagos.pdf` (or Dashboard → *Executive brief (PDF)*).
- Deck: `pitch/Lagos_Electoral_Platform_Pitch.pptx` (11 slides, real figures).

## Walkthrough

| # | Screen | Show | Say |
|---|---|---|---|
| 1 | **Dashboard** (4001) | Validated voters, cover-total match, LGA chart | "7.35 million registered voters, cleaned and checked against INEC's own printed totals: 99.6% of polling units match exactly, and the rest are flagged with the reason." |
| 2 | **Geographic explorer** | Click an LGA on the map → ward → polling unit | "From state to polling unit in three clicks. Every number has a definition and a source." |
| 3 | **Register audit** | Totals, top LGAs by findings, export PDF | "Possible duplicate and invalid registrations, by ward, ready for INEC's claims-and-objections window." |
| 4 | **Field operations** | Change *Large PU* to 600 live; personnel updates | "How many agents we need, where, and which polling units will have queues. Adjust to our deployment policy." |
| 5 | **Situation room** (4000) | Start the simulator (below); the map fills up live | "Election day: every ward officer reports from their phone; leadership sees the state fill in, with missing wards flagged." |
| 6 | **LGA workspace** (4000, `lga.ikeja@demo.local`) | Return a report with a note; approve another | "LGA officers review and correct. Every action has a receipt and a full history." |
| 7 | **Security** | Sign in as a ward officer and try another ward: blocked | "Officers only see their own area. Sensitive roles need a phone code. Everything is logged." |
| 8 | **Leave-behind** | Executive Brief PDF | "This one page updates itself from live data." |

### Live simulator (step 5)

In a fourth window:

```powershell
$env:MONGODB_DB='lagos_eip_demo'; npm run simulate -- --prefill 20 --interval 3
```

A new ward report arrives every 3 seconds. Ctrl+C stops it. Running it again resets to a fresh state.

## Answers to likely questions

- **Is this official INEC data?** It's built from the INEC display register files the party holds. Totals reconcile with INEC's printed figures, but the platform does not publish official statistics.
- **Can it show who people will vote for?** No, and it shouldn't. That is neither possible from the register nor lawful. The value is in planning, register auditing and collation.
- **Is voter data safe?** Names and VINs are never stored in readable form, nobody sees individual records on the dashboard, access is role- and area-restricted with full audit, and data stays on the party's own machine.
- **What does rollout need?** A small server (or this laptop for the pilot), HTTPS, officer accounts, and a confirmed ward report form. See `Deployment_Guide.md`.

## Do not

- Do not project the `.pitch-credentials.txt` or `.demo-credentials.txt` files.
- Do not use the Register lookup screen in front of an audience (it is for data stewards only).
- Do not leave the real-data dashboard open on a shared screen after the meeting.
