# council-moderator-render — cross-cloud access to the GCP Agent Platform

A **cross-cloud access proof**: a React front-end + Node/Express proxy, deployed as
**one Render free web service**, that reaches the `council_moderator` **Vertex AI
Agent Engine** on Google Cloud and **streams** the five departments' answers live.

> **Render stands in for Azure.** The point is that a front-end hosted on a
> *different* cloud — e.g. **Azure App Service** / **Azure Container Apps** — can
> drive a GCP-hosted Agent Engine. Render is just a fast free stand-in; the
> architecture, auth model, and code are identical for Azure.
>
> **Full write-up with diagrams (Mermaid, renders in Markdown):
> [ARCHITECTURE.md](ARCHITECTURE.md).**

## What it proves

- The browser (served from the Render/Azure origin) calls only its **own origin**
  at `POST /api/council/stream` — so there is **no CORS** anywhere.
- The Express server holds an auto-refreshing Google credential (it mints the
  short-lived OAuth bearer tokens itself) and makes the server-to-server REST
  calls to the Agent Engine on
  `us-central1-aiplatform.googleapis.com`. The token never reaches the browser.
- The proxy **relays the agent's stream** as Server-Sent Events: each of the 5
  departments arrives as its own `department` event (the UI fills a card live),
  then the moderator's `synthesis`. A non-streaming `POST /api/council` returning
  `{ text }` is kept as a fallback.

## Architecture

```
Browser (Render/Azure origin)
   |  POST /api/council/stream { prompt }     (same origin, no CORS)
   v
Express server.js  ── Bearer (auto-refreshed cred) ──▶  Vertex AI Agent Engine (GCP)
   |  serves client/dist (React SPA)                 (create_session, streamQuery)
   |                                            5 specialists in-process → Chair
   ^  SSE relay: department x5 → synthesis  ◀──────────  author-tagged event stream
   v
React app  (5 department cards fill live, then the synthesis)
```

One service, two jobs on the same origin:
1. `express.static('client/dist')` + SPA fallback serves the built React app.
2. `POST /api/council/stream` proxies to the reasoning engine and **relays** its
   event stream to the browser as SSE (`department` per specialist, then `synthesis`).

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full component + sequence diagrams
and the **Render → Azure** mapping.

## Layout

```
frontend_test_render/
  server.js         Express: static SPA + /api/council/stream (SSE) + /api/council + /api/health
  package.json      root: express, build (builds client), start (node server.js)
  ARCHITECTURE.md   diagrams + Render→Azure mapping
  README.md
  .gitignore
  .env.example
  client/           Vite React SPA (progressive department cards → synthesis; built to client/dist)
  e2e/              Playwright test (cold-start-robust mount + streaming assertions)
```

## Environment variables (server-side)

**Credential (set exactly ONE — resolved in this priority order at startup):**

| Var | Purpose |
| --- | --- |
| `GOOGLE_ADC_JSON` | **Recommended.** Full JSON of *any* Google credential file (`authorized_user`, `service_account`, `external_account`, …) — auto-refreshed via `google-auth-library`, so it survives past 1 hour with zero re-minting. |
| `GOOGLE_SA_KEY_JSON` | Service-account key JSON — same auto-refresh handling; kept separate so an admin-issued SA key can coexist untouched. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a key file, or run on GCP metadata (Cloud Run/GCE) for keyless ambient ADC. |
| `GOOGLE_ACCESS_TOKEN` | **Legacy.** Static ~1h token, no refresh — last resort; `/api/health` reports `degraded: true` in this mode. |

**Engine coordinates + hardening:**

| Var | Purpose |
| --- | --- |
| `GCP_PROJECT` | `ve-grp-1-333-project3-9rqd` (also accepts `PROJECT`). |
| `GCP_REGION` | `us-central1` (also accepts `REGION`). |
| `ENGINE_ID` | `8893446530510356480`. |
| `COUNCIL_API_KEY` | Optional. If set, `/api/council*` require the `x-council-key` header (and `/api/health` hides coordinates from callers without it). |
| `RATE_LIMIT_PER_MIN` | Optional. Per-IP requests/min on council routes (default `10`, `0` = off). |
| `MAX_INFLIGHT` | Optional. Global concurrent council runs (default `3`; excess gets `429`). |
| `MAX_PROMPT_CHARS` | Optional. Prompt length cap (default `4000`; over gets `413`). |
| `PORT` | Injected by Render; defaults to `8080` locally. |

See `.env.example`. **No secret is ever committed** — `.env` is gitignored.

**Multi-turn:** each response (and the SSE `session` event) carries `{ userId, sessionId }`;
send both back on the next `POST` and the engine resumes the same conversation.

## Run locally

- **Windows PowerShell (primary):**

  ```powershell
  Copy-Item .env.example .env
  # one-time login, then paste your ADC JSON (one line, { to }) into .env as GOOGLE_ADC_JSON:
  gcloud auth application-default login
  Get-Content "$env:APPDATA\gcloud\application_default_credentials.json" -Raw

  npm install          # installs express + google-auth-library
  npm run build        # installs + builds the React client into client/dist
  # load .env into the shell, then:
  npm start            # http://localhost:8080
  ```

- **macOS / Linux:**

  ```bash
  cp .env.example .env
  # one-time login, then paste your ADC JSON (one line, { to }) into .env as GOOGLE_ADC_JSON:
  gcloud auth application-default login
  cat ~/.config/gcloud/application_default_credentials.json

  npm install          # installs express + google-auth-library
  npm run build        # installs + builds the React client into client/dist
  # load .env into the shell, then:
  npm start            # http://localhost:8080
  ```

(The credential setup walkthrough lives in [TOKEN_RELIABILITY.md](TOKEN_RELIABILITY.md).)

Smoke-check the proxy directly:

```bash
curl http://localhost:8080/api/health

# Streaming (watch department events arrive, then synthesis):
curl -N -X POST http://localhost:8080/api/council/stream \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Give a cross-functional readout for a student expense-splitting app."}'

# Non-stream fallback (returns { text }):
curl -X POST http://localhost:8080/api/council \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Give a cross-functional readout for a student expense-splitting app."}'
```

Run the end-to-end Playwright streaming test against a deployed URL:

```bash
cd e2e && npm install && npx playwright install chromium
RENDER_URL="https://<name>.onrender.com" npx playwright test
```

## Deploy on Render (free web service)

- **Runtime:** Node
- **Plan:** free
- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- **Env vars:** `GOOGLE_ADC_JSON` (secret, recommended — see
  [TOKEN_RELIABILITY.md](TOKEN_RELIABILITY.md)), `GCP_PROJECT`, `GCP_REGION`,
  `ENGINE_ID`; optionally `COUNCIL_API_KEY` (secret) and the other hardening vars above.
  An existing deploy still on `GOOGLE_ACCESS_TOKEN` should switch its env var to
  `GOOGLE_ADC_JSON` — no code change.
- The server binds `0.0.0.0:$PORT` (Render injects `PORT`).

### Cold starts & timeouts

Render free services sleep after ~15 min idle; the first request after idle
takes ~30–60s to wake (the SPA bundle request can even abort mid-wake), and the
agent itself can cold-start ~20–60s. The proxy uses a **200s** upstream timeout;
the Playwright test **retries the SPA mount** to survive cold-start bundle aborts.
A warm-up `GET /api/health` before the real request helps. On **Azure App Service**,
enabling **Always On** (paid tier) removes cold starts entirely.

## Security note (read this)

The proxy holds a **real Google credential on a third-party host**, so treat the
env var as a secret (secret-typed env var / Key Vault reference; never log it).

- **Credential setup, reliability, and rotation are covered in
  [TOKEN_RELIABILITY.md](TOKEN_RELIABILITY.md)** — including why `GOOGLE_ADC_JSON`
  auto-refreshes past the old ~1h outage, what a persistent `401` means now
  (revoked credential or lost IAM role, not expiry), and how to revoke.
- The legacy `GOOGLE_ACCESS_TOKEN` mode (static ~1h token, no refresh) is kept
  only as a last resort and is reported as `degraded: true` by `/api/health`.
- For a public deploy, set `COUNCIL_API_KEY` so `/api/council*` require the
  `x-council-key` header; the rate limit, in-flight cap, and prompt cap are on
  by default.
- **This is a POC, not production.** Durable upgrades (SA key, workload identity
  federation, Cloud Run keyless) are config-only but each needs an admin action —
  see the decision matrix in [TOKEN_RELIABILITY.md](TOKEN_RELIABILITY.md).
