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
- The Express server holds a short-lived Google OAuth bearer token and makes the
  server-to-server REST calls to the Agent Engine on
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
Express server.js  ── Bearer GOOGLE_ACCESS_TOKEN ──▶  Vertex AI Agent Engine (GCP)
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

| Var | Purpose |
| --- | --- |
| `GOOGLE_ACCESS_TOKEN` | Short-lived ADC token (~1h) — `Authorization: Bearer` for Vertex. |
| `GCP_PROJECT` | `ve-grp-1-333-project3-9rqd` (also accepts `PROJECT`). |
| `GCP_REGION` | `us-central1` (also accepts `REGION`). |
| `ENGINE_ID` | `8893446530510356480`. |
| `PORT` | Injected by Render; defaults to `8080` locally. |

See `.env.example`. **No secret is ever committed** — `.env` is gitignored.

## Run locally

```bash
cp .env.example .env
# paste a fresh token into .env:
#   gcloud auth application-default print-access-token

npm install          # installs express
npm run build        # installs + builds the React client into client/dist
# load .env into the shell, then:
npm start            # http://localhost:8080
```

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
- **Env vars:** `GOOGLE_ACCESS_TOKEN` (secret), `GCP_PROJECT`, `GCP_REGION`, `ENGINE_ID`
- The server binds `0.0.0.0:$PORT` (Render injects `PORT`).

### Cold starts & timeouts

Render free services sleep after ~15 min idle; the first request after idle
takes ~30–60s to wake (the SPA bundle request can even abort mid-wake), and the
agent itself can cold-start ~20–60s. The proxy uses a **200s** upstream timeout;
the Playwright test **retries the SPA mount** to survive cold-start bundle aborts.
A warm-up `GET /api/health` before the real request helps. On **Azure App Service**,
enabling **Always On** (paid tier) removes cold starts entirely.

## Security note (read this)

`GOOGLE_ACCESS_TOKEN` is a **short-lived (~1h) personal ADC token** deliberately
used only to prove cross-platform reachability. It is a real Google OAuth bearer
token living on a third-party host, so:

- The deploy + test must run inside the token's ~1h lifetime.
- On a `401` from the agent, **re-mint** the token and update the Render env var
  (`PUT /v1/services/{id}/env-vars/GOOGLE_ACCESS_TOKEN`), then redeploy.
- **This is not production.** A durable deployment needs an admin-provisioned
  service account with `roles/aiplatform.user` whose short-lived tokens are
  minted server-side — not a personal ADC token.
