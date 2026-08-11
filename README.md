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

## Two roles, one file

`server.js` runs as either half of the deployment. `UPSTREAM_PROXY_URL` decides which:

| Role | Where | Credential it holds |
| --- | --- | --- |
| **RELAY** (`UPSTREAM_PROXY_URL` set) | Render | **None.** Serves the SPA, forwards `/api/council*`, proves its identity with Render's OIDC token. |
| **PROXY** (unset — the default) | Cloud Run | **None stored.** Tokens come from the GCP metadata server. |

Full rationale: [ARCHITECTURE.md](ARCHITECTURE.md) §4 and
[`../adk-agent-skills/10-render-oidc-keyless.md`](../adk-agent-skills/10-render-oidc-keyless.md).

## Environment variables (server-side)

**Relay (Render):**

| Var | Purpose |
| --- | --- |
| `UPSTREAM_PROXY_URL` | The Cloud Run proxy's https URL. Setting it switches on relay mode; **no Google credential is read in this mode**, even if one is present. |
| `AWS_ROLE_ARN` | Any placeholder. Its presence is what makes Render provision an OIDC token and set `AWS_WEB_IDENTITY_TOKEN_FILE`. We never call AWS. |
| `RELAY_SECRET` | Bring-up fallback shared with the proxy. Remove once OIDC verification is confirmed. |

**Proxy (Cloud Run):**

| Var | Purpose |
| --- | --- |
| `RENDER_OIDC_ISSUER` | `https://oidc.render.com/<tea-…>` — your Render workspace id. |
| `RENDER_OIDC_AUDIENCE` | Expected `aud` claim; `sts.amazonaws.com` for Render's AWS integration. Comma-separated list accepted. |
| `RENDER_ALLOWED_SUBS` | **Set this.** The exact `workspace:…:environment:…:service:…` allowed to call. Without it, any Render service in the world with a valid token is accepted. Read the value off `/api/health` as `lastVerifiedSub`. |

**Credential (PROXY mode only — and on Cloud Run you set NONE of these):**

| Var | Purpose |
| --- | --- |
| *(nothing)* | On Cloud Run, ambient ADC via the metadata server. This is the intended configuration. |
| `GOOGLE_ADC_JSON` | Full JSON of *any* Google credential file (`authorized_user`, `service_account`, `external_account`, …), auto-refreshed. **An `authorized_user` value here is a broad personal credential — see the security note.** This is also the slot the future WIF `external_account` config goes into. |
| `GOOGLE_SA_KEY_JSON` | Service-account key JSON. Not obtainable under this project's IAM, and discouraged. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a key file, or run on GCP metadata for keyless ambient ADC. |
| `GOOGLE_ACCESS_TOKEN` | **Legacy.** Static ~1h token, no refresh; `/api/health` reports `degraded: true`. Used by the offline test suite. |

**Engine coordinates + hardening:**

| Var | Purpose |
| --- | --- |
| `GCP_PROJECT` | `ve-grp-1-333-project3-9rqd` (also accepts `PROJECT`). Proxy only. |
| `GCP_REGION` | `us-central1` (also accepts `REGION`). Proxy only. |
| `ENGINE_ID` | `8893446530510356480`. Proxy only. |
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

## Deploy

Two steps, in this order — the relay needs the proxy's URL.

### 1. The Cloud Run proxy (keyless)

```powershell
./deploy-cloudrun.ps1
```

Deploys as `1056960165012-compute@developer.gserviceaccount.com`, which already
holds `roles/aiplatform.user`. Note what the resulting service does **not** have:
any credential env var at all. Verify:

```bash
curl https://council-proxy-….run.app/api/health
# {"authMode":"metadata-adc","callerGate":"render-oidc",...}
```

It is deployed `--allow-unauthenticated` because Render has no Google identity
to present. Access control is the OIDC `sub` allow-list, not Cloud Run IAM.

### 2. The Render web service (relay)

`render.yaml` is a Blueprint; or configure by hand:

- **Runtime:** Node — set it **explicitly**. A `Dockerfile` exists in this repo for
  the Cloud Run image, and Render would otherwise auto-detect it and build the
  API-only image with no SPA in it.
- **Plan:** free · **Build:** `npm install && npm run build` · **Start:** `npm start`
- **Env vars:** `UPSTREAM_PROXY_URL`, `AWS_ROLE_ARN` (placeholder, triggers OIDC),
  `RELAY_SECRET`, optionally `COUNCIL_API_KEY` and the hardening vars.
  **Nothing Google-related.**
- The server binds `0.0.0.0:$PORT` (Render injects `PORT`).

### 3. Pin the identity — don't skip

```bash
curl https://<render-url>/api/council -d '{"prompt":"hello"}' -H 'content-type: application/json'
curl https://council-proxy-….run.app/api/health    # read lastVerifiedSub
gcloud run services update council-proxy --region us-central1 \
  --update-env-vars "^;;^RENDER_ALLOWED_SUBS=<that value>"
```

Then delete `RELAY_SECRET` from both services. At that point the system holds no
shared secret and no Google credential anywhere.

### Cold starts & timeouts

Render free services sleep after ~15 min idle; the first request after idle
takes ~30–60s to wake (the SPA bundle request can even abort mid-wake), and the
agent itself can cold-start ~20–60s. The proxy uses a **200s** upstream timeout;
the Playwright test **retries the SPA mount** to survive cold-start bundle aborts.
A warm-up `GET /api/health` before the real request helps. On **Azure App Service**,
enabling **Always On** (paid tier) removes cold starts entirely.

## Security note (read this)

**No Google credential is stored anywhere in this deployment.** That is the
design, and it is worth keeping:

- **The Render service must never get `GOOGLE_ADC_JSON`.** Relay mode ignores it,
  but don't set it. An `authorized_user` value is a `cloud-platform`-scoped
  personal credential that can act as its owner across every project they can
  reach — the previous model, and the reason for this rewrite. History:
  [TOKEN_RELIABILITY.md](TOKEN_RELIABILITY.md).
- **`RENDER_ALLOWED_SUBS` is the access control.** The Cloud Run service is
  public; a valid Render OIDC token is what gets you in. Until the `sub` is
  pinned, *any* Render service with a token for the configured audience is
  accepted. Pin it.
- **Rotate what the old model exposed.** If you ran the `GOOGLE_ADC_JSON`
  deployment: `gcloud auth application-default revoke`.
- For a public deploy, set `COUNCIL_API_KEY` so `/api/council*` require the
  `x-council-key` header; the rate limit, in-flight cap, and prompt cap are on
  by default. Note the rate limiter is **per instance and in memory** — it is a
  speed bump, not a quota.
- **Still a POC in one respect:** the relay→proxy hop terminates federation in
  our own verifier rather than at Google STS, because
  `iam.workloadIdentityPools.create` is denied here. One admin grant closes that
  gap — [`../adk-agent-skills/10-render-oidc-keyless.md`](../adk-agent-skills/10-render-oidc-keyless.md) §6.
