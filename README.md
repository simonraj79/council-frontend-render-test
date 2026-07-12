# council-moderator-render

A minimal **cross-platform access proof**: a React front-end and a Node/Express
proxy, deployed as **one Render free web service**, that reaches the
`council_moderator` **Vertex AI Agent Engine** hosted on Google Cloud.

It demonstrates that an Agent Engine deployed on Google Cloud can be driven from
a front-end hosted on a completely different platform (Render.com).

## What it proves

- The browser (served from `https://<name>.onrender.com`) calls only its **own
  origin** at `POST /api/council` — so there is **no CORS** anywhere.
- The Express server holds a short-lived Google OAuth bearer token and makes the
  server-to-server REST calls to the Agent Engine on
  `us-central1-aiplatform.googleapis.com`. The token never reaches the browser.
- The proxy performs the verified two-call ADK pattern: `create_session`, then
  `stream_query` (SSE), aggregating the streamed events into the final
  synthesized moderator readout.

## Architecture

```
Browser (Render origin)
   |  POST /api/council { prompt }        (same origin, no CORS)
   v
Express server.js  ── Bearer GOOGLE_ACCESS_TOKEN ──▶  Vertex AI Agent Engine
   |  serves client/dist (React SPA)                 (create_session, stream_query)
   v
React app
```

One service, two jobs on the same origin:
1. `express.static('client/dist')` + SPA fallback serves the built React app.
2. `POST /api/council` proxies to the reasoning engine and returns `{ text }`.

## Layout

```
frontend_test_render/
  server.js         Express: static SPA + /api/council proxy + /api/health
  package.json      root: express, build (builds client), start (node server.js)
  .gitignore
  .env.example
  README.md
  client/           Vite React SPA (built to client/dist)
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
curl -X POST http://localhost:8080/api/council \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Give a cross-functional readout for a student expense-splitting app."}'
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
takes ~30–60s to wake, and the agent itself can cold-start ~20–60s. The proxy
uses a **120s** upstream timeout, and any Playwright / browser test should wait
with an equally generous timeout. A warm-up `GET /api/health` before the real
request helps.

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
