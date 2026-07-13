// server.js — Express proxy for the council_moderator Agent Engine.
//
// One Render Node web service does two jobs on the SAME origin (zero CORS):
//   1. Serves the built Vite React SPA from ./client/dist (static + SPA fallback).
//   2. Exposes the council API which server-side calls the Vertex AI Reasoning
//      Engine REST API (create_session -> stream_query):
//        - POST /api/council         aggregates the stream, returns { text }.
//        - POST /api/council/stream  RELAYS the stream live as SSE so the browser
//          can progressively reveal each department + the final synthesis.
//
// The browser only ever talks to its own origin, so the Google OAuth bearer
// token never leaves the server.
//
// Credential env vars (resolved ONCE at startup, in PRIORITY order — the first
// three AUTO-REFRESH via google-auth-library so the POC survives past ~1h):
//   GOOGLE_ADC_JSON      RECOMMENDED — full JSON of the user's authorized_user
//                        application_default_credentials.json (client_id/secret +
//                        refresh_token). No admin, no service account.
//   GOOGLE_SA_KEY_JSON   service-account key JSON (type service_account), if an
//                        admin ever provides one.
//   GOOGLE_APPLICATION_CREDENTIALS  key-file path OR run on GCP metadata (Cloud
//                        Run/GCE) — ambient ADC, keyless.
//   GOOGLE_ACCESS_TOKEN  LEGACY static ~1h token from
//                        `gcloud auth application-default print-access-token`
//                        (no refresh — last-resort fallback only).
//
// Other env vars read at runtime:
//   GCP_PROJECT          e.g. ve-grp-1-333-project3-9rqd   (also accepts PROJECT)
//   GCP_REGION           e.g. us-central1                  (also accepts REGION)
//   ENGINE_ID            e.g. 8893446530510356480
//   PORT                 injected by Render; defaults to 8080 locally

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleAuth, UserRefreshClient } from 'google-auth-library';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config (accept both GCP_* and the shorter names for robustness) --------
const PROJECT = process.env.GCP_PROJECT || process.env.PROJECT || '';
const REGION = process.env.GCP_REGION || process.env.REGION || 'us-central1';
const ENGINE_ID = process.env.ENGINE_ID || '';
const UPSTREAM_TIMEOUT_MS = 200000; // 200s — survives Render free-tier + agent cold starts (under Playwright's 240s cap)

const HOST = `${REGION}-aiplatform.googleapis.com`;
const NAME = `projects/${PROJECT}/locations/${REGION}/reasoningEngines/${ENGINE_ID}`;
const BASE = `https://${HOST}/v1beta1/${NAME}`;

// Verified against the live engine: the moderator's final synthesis is the event
// whose node_info.output_for includes the ROOT engine "council_moderator@1"
// (equivalently node_info.path === this rootPath). Specialist events have a
// "/<specialist>@1" suffix on the path and do NOT list the root in output_for.
const ROOT_PATH = 'council_moderator@1/main_orchestration_workflow@1';
const ROOT_OUTPUT_FOR = 'council_moderator@1';

// author key -> human display name for the 5 departments
const DEPARTMENTS = {
  software_engineer: 'Software Engineer',
  product_manager: 'Product Manager',
  ux_ui_designer: 'UX/UI Designer',
  security_sre: 'Security & SRE',
  technical_writer: 'Technical Writer',
};

// ---- Auth: auto-refreshing Google credential (resolved ONCE, lazily) --------
//
// Priority: GOOGLE_ADC_JSON (authorized_user) > GOOGLE_SA_KEY_JSON (service_account)
// > ambient ADC (GOOGLE_APPLICATION_CREDENTIALS key file / GCP metadata server)
// > GOOGLE_ACCESS_TOKEN (legacy static ~1h token). The first three auto-refresh
// via google-auth-library; the legacy token is returned as-is and still expires.
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// Heuristic: are we running on a GCP runtime whose metadata server can mint
// tokens for the attached service account? (Cloud Run / Functions / App Engine.)
function onGcpMetadata() {
  return Boolean(
    process.env.K_SERVICE ||       // Cloud Run / Cloud Functions (2nd gen)
    process.env.FUNCTION_TARGET || // Cloud Functions
    process.env.GAE_ENV ||         // App Engine
    process.env.GCE_METADATA_HOST  // explicit metadata host override
  );
}

// Which credential source is active (or null if none). Never leaks secret values.
function detectAuthMode() {
  if (process.env.GOOGLE_ADC_JSON) return 'adc-user';
  if (process.env.GOOGLE_SA_KEY_JSON) return 'sa-key';
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || onGcpMetadata()) return 'metadata-adc';
  if (process.env.GOOGLE_ACCESS_TOKEN) return 'static-token';
  return null;
}

const AUTH_MODE = detectAuthMode();
// Everything except the legacy static token can be force-refreshed on a 401.
const AUTH_REFRESHABLE = AUTH_MODE !== null && AUTH_MODE !== 'static-token';

let _authClient = null; // cached AuthClient (built once, lazily)

// Build the underlying google-auth-library client for the active mode, once.
async function getAuthClient() {
  if (_authClient) return _authClient;
  switch (AUTH_MODE) {
    case 'adc-user': {
      const c = JSON.parse(process.env.GOOGLE_ADC_JSON);
      _authClient = new UserRefreshClient({
        clientId: c.client_id,
        clientSecret: c.client_secret,
        refreshToken: c.refresh_token,
      });
      return _authClient;
    }
    case 'sa-key': {
      const credentials = JSON.parse(process.env.GOOGLE_SA_KEY_JSON);
      const auth = new GoogleAuth({ credentials, scopes: [CLOUD_PLATFORM_SCOPE] });
      _authClient = await auth.getClient();
      return _authClient;
    }
    case 'metadata-adc': {
      // No explicit credentials: ADC resolves GOOGLE_APPLICATION_CREDENTIALS or
      // the Cloud Run / GCE metadata server. Keyless deploys work with no code change.
      const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
      _authClient = await auth.getClient();
      return _authClient;
    }
    default:
      // 'static-token' / null: no library client to build.
      return null;
  }
}

// Return a FRESH access token string every call. The library caches and
// auto-refreshes for adc-user/sa-key/metadata-adc.
async function getAccessToken() {
  if (!AUTH_MODE) {
    const err = new Error(
      'No Google credential configured. Set one of (priority order): ' +
      'GOOGLE_ADC_JSON (authorized_user JSON, recommended), ' +
      'GOOGLE_SA_KEY_JSON (service_account key JSON), ' +
      'GOOGLE_APPLICATION_CREDENTIALS (key-file path) / GCP metadata, or ' +
      'GOOGLE_ACCESS_TOKEN (legacy static ~1h token).'
    );
    err.status = 500;
    throw err;
  }
  if (AUTH_MODE === 'static-token') return process.env.GOOGLE_ACCESS_TOKEN;

  const client = await getAuthClient();
  const { token } = await client.getAccessToken(); // object { token, ... } — destructure
  if (!token) {
    const err = new Error('failed to obtain a Google access token from the configured credential');
    err.status = 500;
    throw err;
  }
  return token;
}

// Force a fresh token (used by the 401 self-heal). Version-stable approach:
// drop the cached token, then re-mint. No-op for the legacy static token.
async function forceRefreshToken() {
  if (!AUTH_REFRESHABLE) return;
  const client = await getAuthClient();
  if (client && client.credentials) client.credentials.access_token = null;
  await getAccessToken();
}

async function authHeaders() {
  return {
    Authorization: `Bearer ${await getAccessToken()}`,
    'Content-Type': 'application/json',
    // Routes quota/billing for USER credentials (harmless for SA / metadata).
    'x-goog-user-project': PROJECT,
  };
}

// Authenticated POST with a single 401 self-heal retry. On an upstream 401 AND a
// refreshable credential, force a token refresh and retry ONCE. Returns the raw
// Response WITHOUT consuming its body on the success path (so streaming responses
// stay intact). Preserves the AbortController signal on the retry.
async function authedPost(url, bodyObj, signal) {
  const body = JSON.stringify(bodyObj);
  let res = await fetch(url, { method: 'POST', headers: await authHeaders(), body, signal });
  if (res.status === 401 && AUTH_REFRESHABLE) {
    // Drain the failed body to free the socket, then refresh + retry once.
    await res.text().catch(() => {});
    await forceRefreshToken();
    res = await fetch(url, { method: 'POST', headers: await authHeaders(), body, signal });
  }
  return res;
}

// Map an upstream Vertex status to a friendly hint.
function upstreamHint(status) {
  if (status === 401)
    return '401: credential invalid/expired. With GOOGLE_ADC_JSON the proxy auto-refreshes, so a persistent 401 means the credential was revoked or the identity lacks roles/aiplatform.user — refresh GOOGLE_ADC_JSON via `gcloud auth application-default login`.';
  if (status === 403) return 'permission denied for this identity on the reasoning engine';
  if (status === 404) return 'reasoning engine / method not found (check PROJECT / REGION / ENGINE_ID)';
  return 'upstream error';
}

// ---- Step 1: create_session -> returns session id at output.id ---------------
async function createSession(userId, signal) {
  const res = await authedPost(
    `${BASE}:query`,
    { class_method: 'create_session', input: { user_id: userId } },
    signal,
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 800);
    const err = new Error(`create_session ${res.status}: ${upstreamHint(res.status)}`);
    err.status = res.status;
    err.upstream = body;
    throw err;
  }
  const j = await res.json().catch(() => ({}));
  return j?.output?.id || j?.output?.sessionId || null;
}

// ---- Shared stream helpers ---------------------------------------------------
function isModeratorAuthor(author) {
  return /orchestrat|moderator|council|root/i.test(author || '');
}

// Open the upstream :streamQuery?alt=sse fetch. Returns the Response (caller reads body).
async function openStreamQuery(userId, sessionId, message, signal) {
  const input = { user_id: userId, message };
  if (sessionId) input.session_id = sessionId;

  const res = await authedPost(
    `${BASE}:streamQuery?alt=sse`,
    { class_method: 'stream_query', input },
    signal,
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 800);
    const err = new Error(`stream_query ${res.status}: ${upstreamHint(res.status)}`);
    err.status = res.status;
    err.upstream = body;
    throw err;
  }
  if (!res.body) {
    const err = new Error('stream_query returned an empty body');
    err.status = 502;
    throw err;
  }
  return res;
}

// Parse one raw NDJSON/SSE line into a normalized { author, txt, isRoot } or null.
function parseCouncilLine(jsonStr) {
  let ev;
  try {
    ev = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  // Some transports wrap the event; normalize a couple of shapes.
  const node = ev?.content ? ev : ev?.output ? ev.output : ev;
  const parts = node?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const txt = parts.map((p) => (p && p.text ? p.text : '')).join('').trim();
  if (!txt) return null;
  const ni = node.node_info || ev.node_info || {};
  const outFor = Array.isArray(ni.output_for) ? ni.output_for : [];
  const isRoot = outFor.includes(ROOT_OUTPUT_FOR) || ni.path === ROOT_PATH;
  return { author: node.author || ev.author || '', txt, isRoot };
}

// Read the upstream body, splitting NDJSON/SSE lines, invoking onLine(rawLine)
// for each complete data line (already stripped of the optional "data:" prefix).
async function readLines(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const drain = (flush) => {
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (!line || line === '[DONE]') continue;
      if (line[0] === '{' || line[0] === '[') onLine(line);
    }
    if (flush && buf.trim()) {
      let l = buf.trim();
      if (l.startsWith('data:')) l = l.slice(5).trim();
      buf = '';
      if (l && (l[0] === '{' || l[0] === '[')) onLine(l);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    drain(false);
  }
  drain(true);
}

// ---- Non-stream: aggregate the final moderator text (unchanged behavior) -----
async function runCouncil(userId, sessionId, message, signal) {
  const res = await openStreamQuery(userId, sessionId, message, signal);

  const events = []; // { author, txt, isRoot }
  let longest = ''; // fallback: longest single text seen

  await readLines(res, (line) => {
    const ev = parseCouncilLine(line);
    if (!ev) return;
    events.push(ev);
    if (ev.txt.length > longest.length) longest = ev.txt;
  });

  // Prefer the LAST root synthesis event (node_info-based, verified); then the
  // author heuristic; then the last event; then the longest text ever seen.
  const rootEvents = events.filter((e) => e.isRoot);
  if (rootEvents.length) return rootEvents[rootEvents.length - 1].txt;
  const moderator = events.filter((e) => isModeratorAuthor(e.author));
  if (moderator.length) return moderator[moderator.length - 1].txt;
  if (events.length) return events[events.length - 1].txt;
  return longest;
}

// ---- App --------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    // True if ANY accepted credential source is present (not only the legacy token).
    configured: Boolean(PROJECT && ENGINE_ID && AUTH_MODE),
    authMode: AUTH_MODE, // adc-user | sa-key | metadata-adc | static-token | null
    project: PROJECT || null,
    region: REGION,
    engineId: ENGINE_ID || null,
  });
});

app.post('/api/council', async (req, res) => {
  const message = ((req.body && req.body.prompt) || (req.body && req.body.message) || '').toString();
  if (!message.trim()) {
    return res.status(400).json({ error: 'prompt required' });
  }
  if (!PROJECT || !ENGINE_ID) {
    return res.status(500).json({ error: 'server misconfigured: GCP_PROJECT / ENGINE_ID not set' });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const userId = 'render-' + Date.now();
    // Session is best-effort; if it fails, proceed with just {user_id, message}.
    let sid = null;
    try {
      sid = await createSession(userId, ctrl.signal);
    } catch (e) {
      // A hard auth/permission failure will also fail stream_query — surface it now.
      if (e.status === 401 || e.status === 403) throw e;
    }
    const text = await runCouncil(userId, sid, message, ctrl.signal);
    if (!text) {
      return res.status(502).json({ error: 'no synthesized text returned by the agent' });
    }
    return res.json({ text, sessionId: sid });
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: `upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms (cold start)` });
    }
    const status = e.status && e.status >= 400 ? e.status : 500;
    return res.status(status).json({ error: String(e.message || e), upstream: e.upstream });
  } finally {
    clearTimeout(timer);
  }
});

// ---- Streaming: RELAY the council stream to the browser as named SSE events --
//
// SSE contract (proxy -> browser):
//   event: department  data: {"key","name","text"}   (accumulated per specialist)
//   event: synthesis   data: {"text"}                (moderator synthesis, final)
//   event: error       data: {"error","status"}
//   event: done        data: {}
app.post('/api/council/stream', async (req, res) => {
  const message = ((req.body && req.body.prompt) || (req.body && req.body.message) || '').toString();

  // SSE headers — flush immediately so the browser opens the stream.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const sse = (event, obj) => {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(obj) + '\n\n');
  };

  // Guard against writing after the socket is gone.
  let closed = false;
  const ctrl = new AbortController();
  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      sse('done', {});
    } catch {}
    try {
      res.end();
    } catch {}
  };
  const fail = (err, status) => {
    if (closed) return;
    const st = status || (err && err.status && err.status >= 400 ? err.status : 500);
    try {
      sse('error', { error: String((err && err.message) || err || 'stream error'), status: st });
    } catch {}
    finish();
  };

  if (!message.trim()) {
    return fail(new Error('prompt required'), 400);
  }
  if (!PROJECT || !ENGINE_ID) {
    return fail(new Error('server misconfigured: GCP_PROJECT / ENGINE_ID not set'), 500);
  }

  // Abort the upstream fetch if the browser disconnects. NOTE: use res 'close'
  // (fires on real client disconnect / response end), NOT req 'close' — for a POST,
  // req 'close' fires as soon as Express finishes reading the request body, which
  // would abort the upstream before we ever stream a single event.
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  res.on('close', () => {
    closed = true;
    ctrl.abort();
    clearTimeout(timer);
  });

  const deptText = Object.create(null); // author key -> accumulated text
  let rootText = ''; // accumulated moderator synthesis (last root wins)
  let longest = ''; // fallback if no root event ever seen

  try {
    const userId = 'render-' + Date.now();
    let sid = null;
    try {
      sid = await createSession(userId, ctrl.signal);
    } catch (e) {
      // A hard auth/permission failure will also fail stream_query — surface now.
      if (e.status === 401 || e.status === 403) return fail(e);
    }

    const upstream = await openStreamQuery(userId, sid, message, ctrl.signal);

    await readLines(upstream, (line) => {
      if (closed) return;
      const ev = parseCouncilLine(line);
      if (!ev) return;
      if (ev.txt.length > longest.length) longest = ev.txt;

      if (ev.isRoot) {
        // Accumulate the synthesis; keep the longest/last root text.
        rootText = ev.txt.length >= rootText.length ? ev.txt : rootText + ev.txt;
        // Optional interim reveal of the synthesis as it grows.
        sse('synthesis', { text: rootText });
        return;
      }

      const key = ev.author;
      if (key && DEPARTMENTS[key]) {
        // Accumulate in case a specialist emits multiple partial chunks.
        deptText[key] = (deptText[key] || '') + ev.txt;
        sse('department', { key, name: DEPARTMENTS[key], text: deptText[key] });
      }
      // Unknown / other authors: ignore.
    });

    if (closed) return; // client already gone

    const finalText = rootText || longest;
    if (!finalText && Object.keys(deptText).length === 0) {
      return fail(new Error('no synthesized text returned by the agent'), 502);
    }
    sse('synthesis', { text: finalText });
    finish();
  } catch (e) {
    if (closed) return;
    if (e.name === 'AbortError') {
      return fail(new Error(`upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms (cold start)`), 504);
    }
    return fail(e);
  } finally {
    clearTimeout(timer);
  }
});

// ---- Static SPA (registered AFTER the API routes) ---------------------------
const DIST = path.join(__dirname, 'client', 'dist');
app.use(express.static(DIST));
// Catch-all for client-side routing; never intercepts /api/* (handled above).
app.get('*', (_req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`council-moderator proxy listening on 0.0.0.0:${PORT}`);
  if (!AUTH_MODE) {
    console.warn(
      'WARN: no Google credential configured — set GOOGLE_ADC_JSON (recommended), ' +
      'GOOGLE_SA_KEY_JSON, GOOGLE_APPLICATION_CREDENTIALS, or GOOGLE_ACCESS_TOKEN; /api/council will fail'
    );
  } else {
    console.log(`auth mode: ${AUTH_MODE}`);
  }
  if (!PROJECT) console.warn('WARN: GCP_PROJECT/PROJECT not set');
  if (!ENGINE_ID) console.warn('WARN: ENGINE_ID not set');
});
