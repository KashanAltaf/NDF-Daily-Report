# NDF Daily QA Report

Daily Quality Assurance status report for NDF. It is a single-page HTML report with a local/Vercel API that syncs data from **Jira** and **Azure DevOps**, then lets you copy the report for Outlook/Teams or save as PDF.

---

## Quick start (local)

1. Put credentials in `.env` (see Environment below).
2. Install deps: `npm install`
3. Start server: `npm run report:serve`
4. Open: http://localhost:8768/NDF-Daily-QA-Report.html
5. Click **Sync from Jira** (and optionally ADO / Playwright / Postman tools in the toolbar).

Optional auth: `npm run auth:totp-setup` then set `AUTH_SECRET` + `AUTH_TOTP_SECRET`.

---

## What the report contains

| Section | Purpose | Main data source |
|--------|---------|------------------|
| **1. Test Execution Summary** | Counts: total in scope, executed, passed/failed/blocked, coverage %, pass rate % | Azure DevOps **Sync Test Summary** (manual metrics editable) |
| **Scope tested today** | Bullet list of titles verified on UAT **today** | Jira — Kashan Altaf comment `Verified on UAT` (today, Asia/Karachi) |
| **2. Bug / Defect Tracker** | Open / fixed / regression / canceled style tracker + blockers | Jira (and optional ADO bugs) |
| **Defect Detail Log** | Detailed defect rows (ID, PR, module, severity, etc.) | Jira |
| **Enhancements** | Existing-system enhancement bugs | Jira (`IMPROVEMENT` / Tasks) |
| **Sales Portal Enhancements** | Same pool, split when title module is KYC / Sales Portal | Jira |
| **Automation Testing** | Playwright-style module rows + Module Covered | Playwright import / manual |

Draft auto-saves in the browser (`localStorage`). **Reload Template** discards the draft.

---

## How Scope tested today works

**Rule (strict):**

- Projects: **PB** and **POR** (configurable)
- Any issue type (Story, Bug, Task, Sub-task, …)
- Comment body contains **Verified on UAT**
- Comment author is **Kashan Altaf**
- Comment created date is **today** in **Asia/Karachi**
- Panel shows **titles only** (no keys in the bullet text)

**APIs:**

- `GET /api/jira/issues` — full report payload, includes `scopeVerifiedTodayIssues` + `scopeText`
- `GET /api/jira/scope-today` — fast Scope-only endpoint used in parallel on Sync so titles fill even if the full sync is slow

**UI:** Toolbar → **Sync from Jira** applies Scope last (and re-applies) so panel repair does not wipe titles.

---

## Jira sync behaviour (high level)

- Projects: `JIRA_PROJECT` (default `PB,POR`)
- Reporters: Munawar Gul, Kashan Altaf (sub-tasks can match by assignee)
- Open bugs: To Do / Bug/Issue (and related open flows)
- Fixed today: Create-PRD-PR / Done (plus verified-on-UAT treated as fixed where configured)
- UAT-Testing + verified comments drive retest / exclusion rules
- POR issues without a `[Module]` prefix default module to **Space Merchant Portal**
- Enhancements: IMPROVEMENT / Tasks; Sales Portal table if title module mentions KYC or Sales Portal

Timezone for “today”: **Asia/Karachi**.

---

## Azure DevOps

- **Sync Bugs (Azure DevOps)** → bug rows when `ADO_PAT` is set
- **Sync Test Summary (Azure DevOps)** → fills Test Execution Summary metrics for a date range

Without `ADO_PAT`, ADO sync fails; Jira Scope/bugs still work if Jira env is set.

---

## Other toolbar actions

- **Copy for Outlook / Teams** — export-friendly HTML
- **Save Now** / auto-save — browser draft
- **Import Playwright Report** — automation table
- **Import Postman Saved Responses** — Postman helper
- **Print / Save as PDF**
- **Sign out** — when TOTP auth is enabled

---

## Project layout

```
NDF-Daily-Report/
├── NDF-Daily-QA-Report.html   # Report UI + client sync logic
├── login.html                 # Optional TOTP login
├── package.json
├── vercel.json                # Vercel rewrites + function limits
├── .env                       # Secrets (not committed)
├── api/                       # Vercel serverless routes
│   ├── jira/issues.js
│   ├── jira/scope-today.js
│   ├── jira/health.js
│   ├── ado/bugs.js
│   ├── ado/test-summary.js
│   ├── ado/health.js
│   ├── auth/...
│   └── playwright/import/
└── server/
    ├── report-server.js       # Local HTTP server (port 8768)
    ├── report-api.js          # Jira fetch, Scope collect, payload
    ├── jira-config.js         # JQL, projects, statuses
    ├── jira-parse.js
    ├── ado-config.js / ado-client.js
    ├── auth.js
    └── playwright-report-parser.js
```

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `JIRA_BASE_URL` | Atlassian site (default namipay-team) |
| `JIRA_EMAIL` | Jira user email(s), comma-separated |
| `JIRA_API_TOKEN` | API token(s), aligned with emails |
| `JIRA_API_TOKEN_NAMIPAY` | Optional token for @namipay.com.sa |
| `JIRA_PROJECT` | e.g. `PB,POR` |
| `ADO_PAT` / org / project | Azure DevOps sync |
| `AUTH_SECRET` / `AUTH_TOTP_SECRET` / `AUTH_EMAIL` | Optional login |
| `REPORT_PORT` | Local port (default `8768`) |

On Vercel: set the same vars in Project Settings → Environment Variables, then redeploy. `maxDuration` is raised (e.g. 120s) because Jira comment scans can be slow.

---

## Deploy

- **Local:** `npm run report:serve`
- **Vercel:** `api/**` handlers + static HTML; `/` → `NDF-Daily-QA-Report.html`

After Scope/API changes: commit, push `main`, wait for deploy, hard-refresh the live URL, then **Sync from Jira**.

---

## Known operational notes

1. Scope UI empty while API has data → use **localhost:8768** with latest code, hard refresh, Sync; or call `/api/jira/scope-today` to confirm titles.
2. Test Execution numbers empty → run **Sync Test Summary (Azure DevOps)**, not Jira.
3. Full `/api/jira/issues` can take ~30–60s; Scope uses the lighter `/api/jira/scope-today` path in parallel.
4. Draft corruption → **Reload Template**, then Sync again.

---

## npm scripts

| Script | Command |
|--------|---------|
| `npm run report:serve` | Start local report + API |
| `npm run auth:totp-setup` | Generate TOTP setup for login |
