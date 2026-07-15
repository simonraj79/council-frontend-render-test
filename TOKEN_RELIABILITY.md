# Token Reliability Runbook — council_moderator proxy

Faculty runbook for keeping the Render-hosted (or Azure-hosted) proxy's Google
auth working **indefinitely**, so the POC no longer dies ~1 hour after you mint a
token. No admin action and no new GCP infrastructure required.

Target engine: `council_moderator` — project `ve-grp-1-333-project3-9rqd`,
region `us-central1`, engine id `8893446530510356480`.

---

## 1. Root cause

The proxy used to read a **static raw access token** from the `GOOGLE_ACCESS_TOKEN`
env var — the output of `gcloud auth application-default print-access-token`.
That token has a **hard ~1-hour expiry and no refresh mechanism**. About an hour
after minting it, every call fails with:

```
create_session 401: GOOGLE_ACCESS_TOKEN expired or invalid
```

For an unattended teaching POC this means an outage every hour unless someone
re-mints and re-pastes the token by hand.

## 2. The fix

The proxy now obtains an **auto-refreshing credential** via the `google-auth-library`
npm package. It resolves ONE credential at startup and re-mints the underlying
access token silently before each upstream call, so the proxy keeps working past
1 hour with **zero manual re-minting**.

For the POC we use **`GOOGLE_ADC_JSON`** — the full JSON of *your own* Application
Default Credentials (type `authorized_user`: `client_id` + `client_secret` +
`refresh_token`). It runs on the identity you already have
(`roles/aiplatform.user`, which includes `aiplatform.reasoningEngines.query`), so
there is **no admin grant, no service-account creation, and no IAM change**. The
Express proxy and the React SPA stay exactly where they are — only how the proxy
acquires the token changed (plus a one-shot 401 self-heal retry).

Accepted credential env vars (resolved once, in priority order — the first three
auto-refresh):

| Env var | Type | Auto-refresh |
| --- | --- | --- |
| `GOOGLE_ADC_JSON` | **any** Google credential JSON — for this POC, your user ADC (`authorized_user`) — **recommended** | Yes |
| `GOOGLE_SA_KEY_JSON` | service-account key JSON | Yes |
| `GOOGLE_APPLICATION_CREDENTIALS` / GCP metadata | ambient ADC (keyless on Cloud Run/GCE) | Yes |
| `GOOGLE_ACCESS_TOKEN` | legacy static ~1h token | **No** (the old bug) |

Engine coordinates (unchanged): `GCP_PROJECT` (or `PROJECT`), `GCP_REGION` (or
`REGION`), `ENGINE_ID`. `PORT` is injected by Render. On GCP runtimes, ambient
ADC is detected via `K_SERVICE`, `FUNCTION_TARGET`, `GAE_ENV`, or
`GCE_METADATA_HOST`.

## 3. Get your `GOOGLE_ADC_JSON` (one-time)

**Step A — log in once** (opens a browser; approve with your faculty Google account):

```
gcloud auth application-default login
```

**Step B — print the credentials file as one line** so you can copy it whole:

- **Windows PowerShell (primary):**

  ```powershell
  Get-Content "$env:APPDATA\gcloud\application_default_credentials.json" -Raw
  ```

- **macOS / Linux:**

  ```bash
  cat ~/.config/gcloud/application_default_credentials.json
  ```

**Step C — paste the entire JSON** (everything from the leading `{` to the
trailing `}`) as the value of a single **secret** env var named `GOOGLE_ADC_JSON`,
then redeploy. Do not edit or reformat the JSON.

## 4. Set the secret and redeploy

**Render (primary):**
1. Dashboard → open **the service** (the council proxy).
2. **Environment** tab → **Add Environment Variable** (mark it a **secret**).
3. Key `GOOGLE_ADC_JSON`, Value = the JSON from step 3B → **Save Changes**.
4. Trigger a redeploy (**Manual Deploy → Deploy latest commit**, or let the save
   auto-redeploy).

**Azure App Service (equivalent):**
- **App Service → Configuration → Application settings → New application setting**:
  name `GOOGLE_ADC_JSON`, value = the JSON → **Save** (the app restarts).
- Preferred for a real secret: store the JSON in **Azure Key Vault** and set the
  app setting to a **Key Vault reference**
  (`@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)`)
  so the secret value never sits in plain App Service config.

Setting the credential is the whole change — you do **not** need to touch the
code, the SSE contract, department routing, or the engine coordinates.

## 5. Security note

`GOOGLE_ADC_JSON` is your **broad personal credential**: it carries the
`cloud-platform` scope and can act as *you* across **all** your GCP projects, not
just this one engine. Treat it accordingly:

- Keep the secret store locked (secret-typed env var / Key Vault reference,
  least-privilege dashboard access). Never log, echo, or paste it anywhere else.
- It stays valid until **revoked**, ~**6 months of inactivity**, or a
  **credential reset** — and it is bound to one human, so if you leave or reset
  your password/2FA the POC breaks. Because it truly auto-refreshes, a
  **persistent** 401 no longer means "expired" — it means the credential was
  **revoked** or your identity lost `roles/aiplatform.user`. Recovery is to
  re-run `gcloud auth application-default login` and update the secret.
- Revoke it any time with:

  ```
  gcloud auth application-default revoke
  ```

- For anything beyond a POC, graduate to a **scoped service account**
  (Option 2 or 3 below), which removes the personal credential and the
  single-person dependency.

## 6. Decision matrix

**Recommendation: adopt Option 1 (`GOOGLE_ADC_JSON` holding your user refresh
token — the health endpoint reports it as `authMode: "authorized_user"`,
auto-refreshing) for the immediate faculty POC.** It is the only reliable option
that fits the current IAM envelope with **zero admin action**, it permanently
kills the ~1h outage (the library silently re-mints the token before each call),
and it keeps the proxy + SPA exactly where they are — a config change, not a
re-architecture.

| Option | Reliability | Needs admin? | Keeps front-end on Render/Azure? | Effort | Key risk |
| --- | --- | --- | --- | --- | --- |
| **1. `GOOGLE_ADC_JSON` — user refresh token, auto-refresh** *(RECOMMENDED)* | High — auto-refreshes each ~1h; valid until revoked / ~6-month inactivity / credential reset. No manual re-mint. | **No** — uses your own `roles/aiplatform.user`. | **Yes** — proxy unchanged. | **Minimal** — `gcloud auth application-default login` once, paste JSON as one secret env var, redeploy. | Broad **personal** credential in a 3rd-party secret store; dies on revoke / org reauth policy. |
| **2. Service-account key JSON (`GOOGLE_SA_KEY_JSON`)** | High — SA key auto-refreshes, tied to a scoped SA not a person; survives faculty departure. | **Yes** — admin creates SA + key + grants `roles/aiplatform.user`. | **Yes** — proxy unchanged. | Low code (already supported), gated on admin. | Admin dependency; long-lived downloadable key is an exfiltration/secret-sprawl liability. |
| **3. Cloud Run keyless proxy (metadata / ambient ADC)** | Highest — no stored secret; tokens minted + refreshed by the metadata server. | **Yes** — admin grants `reasoningEngines.query` to the Cloud Run runtime SA. | Front-end yes; **proxy moves to GCP** (Cloud Run). | Medium — new Cloud Run deploy + IAM grant + re-point SPA; **zero code change**. | Requires admin + new GCP infra; relocates the token-minting proxy off your hosting. |
| **0. Raw `GOOGLE_ACCESS_TOKEN` (legacy — health reports `degraded: true`)** | Low — hard ~1h expiry, no refresh. | No | Yes | None (status quo). | Guaranteed hourly 401 outage; unusable unattended. |

## 7. Upgrading later is CONFIG, not code

The proxy **already supports Options 2 and 3** in code. The resolution logic
handles `GOOGLE_SA_KEY_JSON` (`service_account`) and ambient ADC
(`GOOGLE_APPLICATION_CREDENTIALS` or the Cloud Run/GCE metadata server) exactly
the same way as `GOOGLE_ADC_JSON`. So graduating from the POC is a **configuration
change, not a code change**:

- **Step 1:** when an admin is available, set `GOOGLE_SA_KEY_JSON` to a scoped
  SA key (removes the personal-identity dependency). One env var; nothing else.
- **Step 2:** for production, deploy the proxy to **Cloud Run keyless** — grant
  `reasoningEngines.query` to the runtime SA and remove the secret entirely; the
  ambient-ADC path is already wired.

## 8. Verify it survives past 1 hour

**A. Health check** — `configured` must be `true`, `authRefreshable` `true`,
`degraded` `false`, and `authMode` should be `authorized_user` (`authMode` is the
credential **type**: `authorized_user | service_account | external_account |
external_account_authorized_user | impersonated_service_account | metadata-adc |
static-token | null`):

- **Windows PowerShell (primary):**

  ```powershell
  Invoke-RestMethod "https://<your-service>.onrender.com/api/health"
  ```

- **macOS / Linux:**

  ```bash
  curl -s https://<your-service>.onrender.com/api/health
  ```

  Expect: `{ ok: true, configured: true, authRefreshable: true, degraded: false, authMode: "authorized_user", project: "ve-grp-1-333-project3-9rqd", region: "us-central1", engineId: "8893446530510356480" }`.

  Notes:

  - `authMode`/`project`/`region`/`engineId` appear only when no `COUNCIL_API_KEY`
    is configured, or when you send the right `x-council-key` header.
  - Add `?deep=1` for a live credential probe: `tokenOk: true` proves a token was
    actually minted (cached ~60 s — safe to point an uptime monitor at).
  - A **mangled `GOOGLE_ADC_JSON` paste fails closed**: health reports
    `misconfigured: true` (with `ok: false`, `degraded: true`) and the parse error
    is never echoed to clients — re-paste the full file contents as a single line,
    from `{` to `}`.

**B. One prompt** — should return synthesized `text`:

- **Windows PowerShell (primary):**

  ```powershell
  Invoke-RestMethod -Method Post -Uri "https://<your-service>.onrender.com/api/council" -ContentType "application/json" -Body '{"prompt":"Give a one-line hello from the council."}'
  ```

- **macOS / Linux:**

  ```bash
  curl -s -X POST https://<your-service>.onrender.com/api/council \
    -H "Content-Type: application/json" \
    -d '{"prompt":"Give a one-line hello from the council."}'
  ```

**C. The real test — wait past 1 hour and re-run step B.** With the old
`GOOGLE_ACCESS_TOKEN` this returned a 401; with `GOOGLE_ADC_JSON` it still returns
`text` because the proxy auto-refreshed the token. No re-mint, no redeploy.

## 9. Optional zero-dependency alternative

If you ever wanted to avoid the `google-auth-library` dependency, you could refresh
the user credential by hand: POST to `https://oauth2.googleapis.com/token` with
`grant_type=refresh_token` plus your `client_id`, `client_secret`, and
`refresh_token`, then cache the returned `access_token` until ~5 minutes before it
expires. We use `google-auth-library` instead because the **same** code path also
handles service-account keys and metadata/ambient ADC — that is exactly what makes
Options 2 and 3 a config-only upgrade.

---

*Do not paste real credential values into this document, tickets, chat, or logs.
`GOOGLE_ADC_JSON`, `GOOGLE_SA_KEY_JSON`, and access tokens are secrets.*
