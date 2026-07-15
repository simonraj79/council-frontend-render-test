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
// Credential env vars (parsed + validated ONCE at startup, in PRIORITY order —
// everything except the legacy static token AUTO-REFRESHES via google-auth-library):
//   GOOGLE_ADC_JSON      RECOMMENDED — full JSON of ANY Google credential file.
//                        All types are accepted and auto-refreshed: authorized_user
//                        (your ADC refresh token — zero admin), service_account,
//                        external_account (workload identity federation),
//                        external_account_authorized_user (workforce), and
//                        impersonated_service_account. Upgrading the credential
//                        later is a CONFIG change, never a code change.
//   GOOGLE_SA_KEY_JSON   same handling as GOOGLE_ADC_JSON (kept as a separate
//                        var so an admin-issued SA key can coexist untouched).
//   GOOGLE_APPLICATION_CREDENTIALS  key-file path OR run on GCP metadata (Cloud
//                        Run/GCE) — ambient ADC, keyless.
//   GOOGLE_ACCESS_TOKEN  LEGACY static ~1h token (no refresh — last resort; the
//                        health endpoint reports degraded:true in this mode).
//
// Hardening env vars (all optional):
//   COUNCIL_API_KEY      if set, /api/council* require header x-council-key
//   RATE_LIMIT_PER_MIN   per-IP requests/min on council routes (default 10, 0=off)
//   MAX_INFLIGHT         global concurrent council runs (default 3)
//   MAX_PROMPT_CHARS     prompt length cap (default 4000)
//   DEBUG_UPSTREAM_ERRORS=1  include raw upstream error bodies in responses (off
//                        by default: they are logged server-side only)
//
// Engine coordinates:
//   GCP_PROJECT          e.g. ve-grp-1-333-project3-9rqd   (also accepts PROJECT)
//   GCP_REGION           e.g. us-central1                  (also accepts REGION)
//   ENGINE_ID            e.g. 8893446530510356480
//   VERTEX_BASE_URL      test hook: override https://<region>-aiplatform.googleapis.com
//   ROOT_AGENT_NAME / ROOT_NODE_NAME  agent identifiers used for synthesis routing
//                        (defaults match this repo's council_moderator workflow)
//   PORT                 injected by Render; defaults to 8080 locally

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GoogleAuth } from 'google-auth-library';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config (accept both GCP_* and the shorter names for robustness) --------
const PROJECT = process.env.GCP_PROJECT || process.env.PROJECT || '';
const REGION = process.env.GCP_REGION || process.env.REGION || 'us-central1';
const ENGINE_ID = process.env.ENGINE_ID || '';
// 200s default — survives Render free-tier + agent cold starts (under Playwright's 240s cap)
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 200000);
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 4000);
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 3);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 10);
const COUNCIL_API_KEY = process.env.COUNCIL_API_KEY || '';
const DEBUG_UPSTREAM_ERRORS = process.env.DEBUG_UPSTREAM_ERRORS === '1';

const HOST = `${REGION}-aiplatform.googleapis.com`;
const VERTEX_BASE_URL = process.env.VERTEX_BASE_URL || `https://${HOST}`;
const NAME = `projects/${PROJECT}/locations/${REGION}/reasoningEngines/${ENGINE_ID}`;
const BASE = `${VERTEX_BASE_URL}/v1beta1/${NAME}`;

// ---- Synthesis routing (version-agnostic) ------------------------------------
// The moderator's final synthesis is the event whose node_info.output_for names
// the ROOT engine, or whose node_info.path is exactly the root workflow node.
// ADK appends an @N invocation counter to both — @1 on the first run, higher on
// reruns/multi-turn — so we match the NAMES and accept any counter instead of
// pinning the literal '@1' strings (which silently broke on rename/rerun).
const ROOT_AGENT_NAME = process.env.ROOT_AGENT_NAME || 'council_moderator';
const ROOT_NODE_NAME = process.env.ROOT_NODE_NAME || 'main_orchestration_workflow';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROOT_OUTPUT_RE = new RegExp(`^${escRe(ROOT_AGENT_NAME)}@\\d+$`);
const ROOT_PATH_RE = new RegExp(`^${escRe(ROOT_AGENT_NAME)}@\\d+/${escRe(ROOT_NODE_NAME)}@\\d+$`);

// Display-name overrides for known departments. Any OTHER specialist author the
// agent emits is still relayed, with a name derived from its key — a renamed or
// newly added specialist shows up instead of silently disappearing.
const DEPARTMENT_NAMES = {
  software_engineer: 'Software Engineer',
  product_manager: 'Product Manager',
  ux_ui_designer: 'UX/UI Designer',
  security_sre: 'Security & SRE',
  technical_writer: 'Technical Writer',
};
function departmentDisplayName(key) {
  if (DEPARTMENT_NAMES[key]) return DEPARTMENT_NAMES[key];
  return key
    .split(/[_\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ---- Errors: only messages explicitly marked safe are ever sent to clients ---
function httpErr(status, safeMessage) {
  const err = new Error(safeMessage);
  err.status = status;
  err.safe = true;
  return err;
}

// ---- Auth: universal auto-refreshing Google credential ------------------------
//
// GOOGLE_ADC_JSON / GOOGLE_SA_KEY_JSON are parsed ONCE here at startup. A mangled
// paste therefore fails loudly in the logs at boot — and is NEVER echoed to a
// client (JSON.parse SyntaxErrors embed fragments of the raw input, which for a
// credential means fragments of the secret itself).
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function onGcpMetadata() {
  return Boolean(
    process.env.K_SERVICE ||       // Cloud Run / Cloud Functions (2nd gen)
    process.env.FUNCTION_TARGET || // Cloud Functions
    process.env.GAE_ENV ||         // App Engine
    process.env.GCE_METADATA_HOST  // explicit metadata host override
  );
}

let CRED_JSON = null;        // parsed credential JSON (never logged)
let AUTH_MODE = null;        // credential type string | 'metadata-adc' | 'static-token' | null
let AUTH_MISCONFIGURED = false;

for (const envName of ['GOOGLE_ADC_JSON', 'GOOGLE_SA_KEY_JSON']) {
  const raw = process.env[envName];
  if (!raw || !raw.trim()) continue;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      throw new Error('not a credential object');
    }
    CRED_JSON = parsed;
    AUTH_MODE = parsed.type; // authorized_user | service_account | external_account | ...
  } catch {
    // Deliberately do NOT log the parse error (it embeds raw input) and do NOT
    // fall through to a weaker credential — fail closed and say so in health.
    AUTH_MISCONFIGURED = true;
    console.error(
      `ERROR: ${envName} is set but is not valid credential JSON (details withheld — ` +
      're-paste the full file contents as a single line, from { to }).'
    );
  }
  break; // first present env var wins, even when invalid
}
if (!AUTH_MODE && !AUTH_MISCONFIGURED) {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || onGcpMetadata()) AUTH_MODE = 'metadata-adc';
  else if (process.env.GOOGLE_ACCESS_TOKEN) AUTH_MODE = 'static-token';
}
const AUTH_REFRESHABLE = Boolean(AUTH_MODE) && AUTH_MODE !== 'static-token';

let _authClient = null; // cached AuthClient (built once, lazily)

// ONE code path for every credential JSON type: GoogleAuth resolves the right
// client (UserRefreshClient / JWT / ExternalAccount / Impersonated) itself.
async function getAuthClient() {
  if (_authClient) return _authClient;
  const auth = CRED_JSON
    ? new GoogleAuth({ credentials: CRED_JSON, scopes: [CLOUD_PLATFORM_SCOPE] })
    : new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] }); // ambient ADC / metadata
  _authClient = await auth.getClient();
  return _authClient;
}

// Return a fresh access token string every call. The library caches and
// auto-refreshes ahead of expiry for every non-static mode.
async function getAccessToken() {
  if (AUTH_MISCONFIGURED) {
    throw httpErr(500, 'server credential is misconfigured — the operator must re-set the credential env var');
  }
  if (!AUTH_MODE) {
    throw httpErr(
      500,
      'No Google credential configured. Set one of (priority order): GOOGLE_ADC_JSON ' +
      '(any Google credential JSON, recommended), GOOGLE_SA_KEY_JSON, ' +
      'GOOGLE_APPLICATION_CREDENTIALS / GCP metadata, or GOOGLE_ACCESS_TOKEN (legacy static ~1h token).'
    );
  }
  if (AUTH_MODE === 'static-token') return process.env.GOOGLE_ACCESS_TOKEN;

  let token;
  try {
    const client = await getAuthClient();
    ({ token } = await client.getAccessToken());
  } catch (e) {
    // Mint failures can embed request/JSON details — log server-side, send canned text.
    console.error('auth: token mint failed:', (e && e.message) || e);
    throw httpErr(500, 'failed to obtain a Google access token from the configured credential');
  }
  if (!token) {
    throw httpErr(500, 'failed to obtain a Google access token from the configured credential');
  }
  return token;
}

// Force a fresh token (used by the 401 self-heal). Rebuilding the client is the
// only approach that re-mints for EVERY credential type — nulling one cached
// field only works for UserRefreshClient (JWT/gtoken and external-account
// clients keep their own caches and would re-send the same rejected token).
async function forceRefreshToken() {
  if (!AUTH_REFRESHABLE) return;
  _authClient = null;
  await getAccessToken();
}

// Cached credential liveness for /api/health?deep=1 (never more than 1 probe/min).
let _lastTokenCheck = { at: 0, ok: null };
async function tokenLiveness() {
  const now = Date.now();
  if (_lastTokenCheck.ok !== null && now - _lastTokenCheck.at < 60000) return _lastTokenCheck.ok;
  let ok = false;
  try {
    const token = await getAccessToken();
    if (AUTH_MODE === 'static-token') {
      // A static token "exists" even when expired — ask tokeninfo whether it is live.
      const r = await fetch(
        'https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(token)
      );
      ok = r.ok;
    } else {
      ok = Boolean(token); // a successful mint IS the liveness proof
    }
  } catch {
    ok = false;
  }
  _lastTokenCheck = { at: now, ok };
  return ok;
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
    await res.text().catch(() => {}); // drain the failed body to free the socket
    await forceRefreshToken();
    res = await fetch(url, { method: 'POST', headers: await authHeaders(), body, signal });
  }
  return res;
}

// Map an upstream Vertex status to a friendly, client-safe hint.
function upstreamHint(status) {
  if (status === 401)
    return '401: credential invalid/expired. With GOOGLE_ADC_JSON the proxy auto-refreshes, so a persistent 401 means the credential was revoked or the identity lacks roles/aiplatform.user — refresh GOOGLE_ADC_JSON via `gcloud auth application-default login`.';
  if (status === 403) return 'permission denied for this identity on the reasoning engine';
  if (status === 404) return 'reasoning engine / method not found (check PROJECT / REGION / ENGINE_ID)';
  if (status === 429) return 'upstream quota exhausted — retry shortly';
  return 'upstream error';
}

// Raise a client-safe error for a failed upstream response; the raw body is
// attached for SERVER-SIDE logging only (never sent to clients unless
// DEBUG_UPSTREAM_ERRORS=1).
async function upstreamFailure(phase, res) {
  const body = (await res.text().catch(() => '')).slice(0, 800);
  const err = httpErr(res.status, `${phase} ${res.status}: ${upstreamHint(res.status)}`);
  err.upstream = body;
  return err;
}

// ---- Step 1: create_session -> returns session id at output.id ---------------
async function createSession(userId, signal) {
  const res = await authedPost(
    `${BASE}:query`,
    { class_method: 'create_session', input: { user_id: userId } },
    signal,
  );
  if (!res.ok) throw await upstreamFailure('create_session', res);
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
  if (!res.ok) throw await upstreamFailure('stream_query', res);
  if (!res.body) throw httpErr(502, 'stream_query returned an empty body');
  return res;
}

let _parseFailures = 0; // logged once per process so silent drops become visible

// Parse one payload into a normalized event, or null.
// Shapes handled:
//   { author, content:{parts:[...]}, node_info:{...}, partial? }  (plain / wrapped in .output)
//   { error: { code, status, message } }  -> { upstreamError }   (mid-stream failures)
function parseCouncilLine(jsonStr) {
  let ev;
  try {
    ev = JSON.parse(jsonStr);
  } catch {
    if (_parseFailures++ === 0) {
      console.warn('stream: dropped an unparseable payload (logged once); length=', jsonStr.length);
    }
    return null;
  }
  const node = ev?.content ? ev : ev?.output ? ev.output : ev;

  // Mid-stream upstream errors arrive as data payloads, not HTTP statuses. If we
  // ignored them the stream would end looking "complete" with partial output.
  const errObj = node?.error || ev?.error;
  if (errObj && typeof errObj === 'object' && (errObj.code || errObj.status || errObj.message)) {
    const code = Number(errObj.code);
    return { upstreamError: { code: code >= 400 && code < 600 ? code : 502, status: errObj.status || '' } };
  }

  const parts = node?.content?.parts;
  if (!Array.isArray(parts)) return null;
  // Exclude thought parts: gemini-2.5 models can attach {thought:true} reasoning
  // parts which must never reach the UI as if they were the answer.
  const txt = parts.filter((p) => p && p.text && !p.thought).map((p) => p.text).join('').trim();
  if (!txt) return null;

  const ni = node.node_info || ev.node_info || {};
  const outFor = Array.isArray(ni.output_for) ? ni.output_for : [];
  const isRoot =
    outFor.some((s) => typeof s === 'string' && ROOT_OUTPUT_RE.test(s)) ||
    (typeof ni.path === 'string' && ROOT_PATH_RE.test(ni.path));
  return {
    author: node.author || ev.author || '',
    txt,
    isRoot,
    partial: Boolean(node.partial ?? ev.partial),
  };
}

// Merge a new event's text into what we've accumulated for the same author.
// Upstreams vary: partial deltas, cumulative snapshots (each event repeats all
// prior text), or multiple distinct final messages. Handle all three.
function accumulateText(prev, ev) {
  if (!prev) return ev.txt;
  if (ev.partial) return prev + ev.txt;          // delta chunk
  if (ev.txt.startsWith(prev)) return ev.txt;    // cumulative snapshot — replace
  if (prev.startsWith(ev.txt) || prev.includes(ev.txt)) return prev; // duplicate re-send
  return prev + '\n\n' + ev.txt;                 // genuinely new final message
}

// Read the upstream body and invoke onPayload(jsonString) once per COMPLETE
// payload. The upstream has been observed in two framings: NDJSON-style (one
// complete JSON per "data:" line, NO blank separator lines) and spec SSE (an
// event's "data:" lines joined at a blank line, where one JSON document may
// span several lines). We buffer "data:" lines and emit as soon as the joined
// buffer parses as complete JSON — which handles both, plus raw NDJSON lines
// with no "data:" prefix at all. If onPayload throws, the upstream read is
// cancelled and the error propagates.
async function readEvents(res, onPayload) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let dataLines = [];

  const emit = (payload) => {
    const p = payload.trim();
    if (!p || p === '[DONE]') return;
    if (p[0] === '{' || p[0] === '[') onPayload(p);
  };
  // force=true (event boundary / stream end): emit whatever is buffered, letting
  // parseCouncilLine log-and-drop if it is genuinely malformed. force=false
  // (mid-event): emit only when the buffer is already complete JSON.
  const flushEvent = (force) => {
    if (!dataLines.length) return;
    const joined = dataLines.join('\n').trim();
    if (!joined || joined === '[DONE]') { dataLines = []; return; }
    if (joined[0] !== '{' && joined[0] !== '[') { dataLines = []; return; }
    if (!force) {
      try { JSON.parse(joined); } catch { return; } // incomplete — keep buffering
    }
    dataLines = [];
    emit(joined);
  };
  const handleLine = (line) => {
    if (line === '') return flushEvent(true);                    // SSE event boundary
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
      return flushEvent(false);
    }
    if (/^(event|id|retry):/.test(line) || line.startsWith(':')) return; // SSE metadata
    flushEvent(true);
    emit(line);                                                  // raw NDJSON line
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx).replace(/\r$/, ''));
        buf = buf.slice(idx + 1);
      }
    }
    buf += dec.decode(); // flush the decoder
    if (buf.trim()) handleLine(buf.replace(/\r$/, ''));
    flushEvent(true);
  } catch (e) {
    try { reader.cancel(); } catch {}
    throw e;
  }
}

// ---- Non-stream: aggregate the final moderator text ---------------------------
async function runCouncil(userId, sessionId, message, signal) {
  const res = await openStreamQuery(userId, sessionId, message, signal);

  let rootText = '';
  let moderatorText = '';
  let longest = '';

  await readEvents(res, (line) => {
    const ev = parseCouncilLine(line);
    if (!ev) return;
    if (ev.upstreamError) {
      throw httpErr(ev.upstreamError.code, `upstream ended the stream with ${ev.upstreamError.status || ev.upstreamError.code}: ${upstreamHint(ev.upstreamError.code)}`);
    }
    if (ev.txt.length > longest.length) longest = ev.txt;
    if (ev.isRoot) rootText = accumulateText(rootText, ev);
    else if (ev.author === ROOT_AGENT_NAME || isModeratorAuthor(ev.author)) {
      moderatorText = accumulateText(moderatorText, ev);
    }
  });

  // Prefer the structural root synthesis; then the moderator-author fallback;
  // then the longest text ever seen.
  return rootText || moderatorText || longest;
}

// ---- Request validation helpers ----------------------------------------------
const USER_ID_RE = /^[A-Za-z0-9._-]{3,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function extractCouncilInput(body) {
  const message = ((body && body.prompt) || (body && body.message) || '').toString();
  const userId =
    body && typeof body.userId === 'string' && USER_ID_RE.test(body.userId)
      ? body.userId
      : 'render-' + crypto.randomUUID();
  const sessionId =
    body && typeof body.sessionId === 'string' && SESSION_ID_RE.test(body.sessionId)
      ? body.sessionId
      : null;
  return { message, userId, sessionId };
}

function validatePrompt(message) {
  if (!message.trim()) return httpErr(400, 'prompt required');
  if (message.length > MAX_PROMPT_CHARS) {
    return httpErr(413, `prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  }
  if (!PROJECT || !ENGINE_ID) {
    return httpErr(500, 'server misconfigured: GCP_PROJECT / ENGINE_ID not set');
  }
  return null;
}

// Send an error to the client without leaking internals: safe messages pass
// through; anything else is logged server-side and replaced with canned text.
function clientError(e) {
  const status = e && e.status >= 400 && e.status < 600 ? e.status : 500;
  const message = e && e.safe ? e.message : 'internal proxy error';
  if (!(e && e.safe)) console.error('council: unexpected error:', (e && e.stack) || e);
  if (e && e.upstream) console.error(`council: upstream body (${status}):`, e.upstream.slice(0, 400));
  const payload = { error: message };
  if (DEBUG_UPSTREAM_ERRORS && e && e.upstream) payload.upstream = e.upstream;
  return { status, payload };
}

// ---- Abuse guards --------------------------------------------------------------
function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireCouncilKey(req, res, next) {
  if (!COUNCIL_API_KEY) return next(); // opt-in: open when unset (local dev unchanged)
  const presented = req.get('x-council-key') || '';
  if (!timingSafeEq(presented, COUNCIL_API_KEY)) {
    return res.status(401).json({ error: 'unauthorized: missing or invalid x-council-key' });
  }
  next();
}

const rateWindows = new Map(); // ip -> { start, count }
function rateLimit(req, res, next) {
  if (RATE_LIMIT_PER_MIN <= 0) return next();
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const w = rateWindows.get(ip);
  if (!w || now - w.start >= 60000) {
    rateWindows.set(ip, { start: now, count: 1 });
    return next();
  }
  if (++w.count > RATE_LIMIT_PER_MIN) {
    return res.status(429).json({ error: 'rate limit exceeded — try again in a minute' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of rateWindows) if (now - w.start >= 120000) rateWindows.delete(ip);
}, 60000).unref();

let inFlight = 0; // global cap on concurrent (expensive, minutes-long) council runs

// ---- App ----------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // Render terminates TLS in front of us; trust one hop for req.ip
app.use(express.json({ limit: '16kb' })); // the API only ever carries a prompt string

app.get('/api/health', async (req, res) => {
  const configured = Boolean(PROJECT && ENGINE_ID && AUTH_MODE && !AUTH_MISCONFIGURED);
  const body = {
    ok: configured,
    configured,
    authRefreshable: AUTH_REFRESHABLE,
    // degraded: working-for-now states an operator must still fix
    degraded: AUTH_MISCONFIGURED || AUTH_MODE === 'static-token' || !AUTH_MODE,
  };
  if (AUTH_MISCONFIGURED) body.misconfigured = true;
  if (req.query.deep === '1') {
    body.tokenOk = await tokenLiveness(); // cached ~60s; safe to point uptime monitors at
    body.ok = configured && body.tokenOk;
  }
  // Resource coordinates + auth mode are for the owner, not for anonymous recon:
  // shown when no API key is configured (fully open deploy) or when the caller
  // presents the key.
  const authorized = !COUNCIL_API_KEY || timingSafeEq(req.get('x-council-key') || '', COUNCIL_API_KEY);
  if (authorized) {
    body.authMode = AUTH_MODE; // credential type | metadata-adc | static-token | null
    body.project = PROJECT || null;
    body.region = REGION;
    body.engineId = ENGINE_ID || null;
  }
  res.json(body);
});

app.post('/api/council', requireCouncilKey, rateLimit, async (req, res) => {
  const { message, userId, sessionId: givenSession } = extractCouncilInput(req.body);
  const invalid = validatePrompt(message);
  if (invalid) {
    const { status, payload } = clientError(invalid);
    return res.status(status).json(payload);
  }
  if (inFlight >= MAX_INFLIGHT) {
    return res.status(429).json({ error: `busy: ${MAX_INFLIGHT} council runs already in flight — try again shortly` });
  }
  inFlight++;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // Session is best-effort; if it fails, proceed with just {user_id, message}.
    let sid = givenSession;
    if (!sid) {
      try {
        sid = await createSession(userId, ctrl.signal);
      } catch (e) {
        // A hard auth/permission failure will also fail stream_query — surface it now.
        if (e.status === 401 || e.status === 403) throw e;
      }
    }
    const text = await runCouncil(userId, sid, message, ctrl.signal);
    if (!text) {
      return res.status(502).json({ error: 'no synthesized text returned by the agent' });
    }
    // userId + sessionId let the client hold a multi-turn conversation: send both
    // back on the next POST and the engine resumes the same session.
    return res.json({ text, userId, sessionId: sid });
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: `upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms (cold start)` });
    }
    const { status, payload } = clientError(e);
    return res.status(status).json(payload);
  } finally {
    inFlight--;
    clearTimeout(timer);
  }
});

// ---- Streaming: RELAY the council stream to the browser as named SSE events --
//
// SSE contract (proxy -> browser):
//   event: session     data: {"userId","sessionId"}              (echo for multi-turn reuse)
//   event: department  data: {"key","name","text"}               (accumulated per specialist)
//   event: synthesis   data: {"text"}                            (moderator synthesis)
//   event: error       data: {"error","status","retryable"?}
//   event: done        data: {"complete": true|false}            (false = no synthesis seen)
app.post('/api/council/stream', requireCouncilKey, rateLimit, async (req, res) => {
  const { message, userId, sessionId: givenSession } = extractCouncilInput(req.body);

  // Reject invalid/over-capacity requests as PLAIN HTTP before opening the SSE
  // stream, so clients and infrastructure see real status codes.
  const invalid = validatePrompt(message);
  if (invalid) {
    const { status, payload } = clientError(invalid);
    return res.status(status).json(payload);
  }
  if (inFlight >= MAX_INFLIGHT) {
    return res.status(429).json({ error: `busy: ${MAX_INFLIGHT} council runs already in flight — try again shortly` });
  }
  inFlight++;

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
  const finish = (complete) => {
    if (closed) return;
    closed = true;
    try { sse('done', { complete: Boolean(complete) }); } catch {}
    try { res.end(); } catch {}
  };
  const fail = (err, status) => {
    if (closed) return;
    const { status: st, payload } = clientError(
      status ? Object.assign(err, { status, safe: err.safe ?? true }) : err
    );
    const retryable = st === 429 || st === 502 || st === 503 || st === 504;
    try { sse('error', { ...payload, status: st, retryable }); } catch {}
    finish(false);
  };

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
  let rootText = '';       // structural (node_info) synthesis — authoritative
  let moderatorText = '';  // author-name fallback if no structural root event arrives
  let longest = '';        // last-resort fallback

  try {
    let sid = givenSession;
    if (!sid) {
      try {
        sid = await createSession(userId, ctrl.signal);
      } catch (e) {
        // A hard auth/permission failure will also fail stream_query — surface now.
        if (e.status === 401 || e.status === 403) return fail(e);
      }
    }
    sse('session', { userId, sessionId: sid || null });

    const upstream = await openStreamQuery(userId, sid, message, ctrl.signal);

    await readEvents(upstream, (line) => {
      if (closed) return;
      const ev = parseCouncilLine(line);
      if (!ev) return;
      if (ev.upstreamError) {
        // e.g. the token expired mid-stream: surface a real error instead of
        // letting partial output masquerade as a complete answer.
        throw httpErr(
          ev.upstreamError.code,
          `upstream ended the stream with ${ev.upstreamError.status || ev.upstreamError.code}: ${upstreamHint(ev.upstreamError.code)}`
        );
      }
      if (ev.txt.length > longest.length) longest = ev.txt;

      if (ev.isRoot) {
        rootText = accumulateText(rootText, ev);
        sse('synthesis', { text: rootText }); // interim reveal as it grows
        return;
      }
      const key = ev.author;
      if (!key) return;
      if (key === ROOT_AGENT_NAME || isModeratorAuthor(key)) {
        // The moderator's own sub-agent chunks: keep as fallback synthesis, but
        // the structural root event remains authoritative.
        moderatorText = accumulateText(moderatorText, ev);
        return;
      }
      // ANY other author is a department — hardcoding the five known keys made
      // a renamed/added specialist vanish silently.
      deptText[key] = accumulateText(deptText[key], ev);
      sse('department', { key, name: departmentDisplayName(key), text: deptText[key] });
    });

    if (closed) return; // client already gone

    const finalText = rootText || moderatorText || longest;
    if (!finalText && Object.keys(deptText).length === 0) {
      return fail(httpErr(502, 'no synthesized text returned by the agent'));
    }
    sse('synthesis', { text: finalText });
    // complete=true only when a genuine synthesis (structural or moderator-authored)
    // arrived — a stream that died after two departments must not look finished.
    finish(Boolean(rootText || moderatorText));
  } catch (e) {
    if (closed) return;
    if (e.name === 'AbortError') {
      return fail(httpErr(504, `upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms (cold start)`));
    }
    return fail(e);
  } finally {
    inFlight--;
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
  if (AUTH_MISCONFIGURED) {
    console.error('ERROR: credential env var present but unparseable — all council calls will fail until it is re-set');
  } else if (!AUTH_MODE) {
    console.warn(
      'WARN: no Google credential configured — set GOOGLE_ADC_JSON (recommended), ' +
      'GOOGLE_SA_KEY_JSON, GOOGLE_APPLICATION_CREDENTIALS, or GOOGLE_ACCESS_TOKEN; /api/council will fail'
    );
  } else {
    console.log(`auth mode: ${AUTH_MODE}${AUTH_REFRESHABLE ? ' (auto-refreshing)' : ' (STATIC — expires ~1h, degraded)'}`);
  }
  if (!PROJECT) console.warn('WARN: GCP_PROJECT/PROJECT not set');
  if (!ENGINE_ID) console.warn('WARN: ENGINE_ID not set');
  if (!COUNCIL_API_KEY) console.log('note: COUNCIL_API_KEY unset — /api/council is open (set it to require x-council-key)');
});
