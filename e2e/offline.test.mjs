// offline.test.mjs — deterministic regression tests. No network, no GCP, no
// credential. Run with:  npm test
//
// These exist because the live Playwright suite cannot catch the class of bug
// that actually bit us: the agent was redeployed with renamed workflow nodes,
// the proxy's synthesis regex silently stopped matching, and the only visible
// symptom was "the synthesis panel fills in late" — which looks like slowness,
// not breakage. A mock that replays the REAL event shapes turns that into a
// failing assertion.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockVertex, SPECIALISTS, SYNTHESIS_TEXT } from './mock-vertex.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- harness -----------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(env, { expectHealthy = true } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logs.join('')}`);
    }
    try {
      const r = await fetch(`${url}/api/health`);
      const j = await r.json();
      if (!expectHealthy || j.configured) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`server did not become healthy in 15s:\n${logs.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    logs: () => logs.join(''),
    close: () => new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    }),
  };
}

// Collect the SSE frames from a council stream, in arrival order.
async function readCouncilStream(url, body, headers = {}) {
  const res = await fetch(`${url}/api/council/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { status: res.status, frames: [], json: await res.json().catch(() => ({})) };
  }
  const frames = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (event && data) frames.push({ event, data: JSON.parse(data) });
    }
  }
  return { status: res.status, frames };
}

const of = (frames, name) => frames.filter((f) => f.event === name);

// ---- proxy mode against the mock engine --------------------------------------

describe('proxy mode: synthesis routing against the real 2026-07-16 event shapes', () => {
  let mock, proxy;

  before(async () => {
    mock = await startMockVertex({ frameDelayMs: 5 });
    proxy = await startServer({
      VERTEX_BASE_URL: mock.url,
      GCP_PROJECT: 'test-project',
      GCP_REGION: 'us-central1',
      ENGINE_ID: '8893446530510356480',
      GOOGLE_ACCESS_TOKEN: 'offline-test-token', // mock ignores it; keeps auth configured
      RATE_LIMIT_PER_MIN: '0',
    });
  });
  after(async () => { await proxy?.close(); await mock?.close(); });

  test('emits the synthesis PROGRESSIVELY, not just once at the end', async () => {
    const { frames } = await readCouncilStream(proxy.url, { prompt: 'design a login flow' });
    const synth = of(frames, 'synthesis');
    // Before the fix this was exactly 1 — the end-of-stream flush — because
    // isRoot never became true, so the panel stayed empty for the whole run.
    assert.ok(
      synth.length >= 2,
      `expected >=2 synthesis frames (progressive reveal), got ${synth.length}. ` +
      'The chair event is not being recognised as the synthesis.'
    );
    const doneIdx = frames.findIndex((f) => f.event === 'done');
    const firstSynthIdx = frames.findIndex((f) => f.event === 'synthesis');
    assert.ok(firstSynthIdx !== -1 && firstSynthIdx < doneIdx - 1,
      'a synthesis frame must arrive well before done');
  });

  test('synthesis text is the chair text exactly — the duplicate echo is collapsed', async () => {
    const { frames } = await readCouncilStream(proxy.url, { prompt: 'design a login flow' });
    const last = of(frames, 'synthesis').at(-1);
    assert.equal(last.data.text, SYNTHESIS_TEXT,
      'the terminal echo must be deduped, not concatenated onto the chair text');
  });

  test('exactly the five specialists become department cards', async () => {
    const { frames } = await readCouncilStream(proxy.url, { prompt: 'design a login flow' });
    const keys = [...new Set(of(frames, 'department').map((f) => f.data.key))].sort();
    assert.deepEqual(keys, [...SPECIALISTS].sort());
    assert.ok(!keys.includes('council_chair'), 'the chair must never render as a department card');
    assert.ok(!keys.includes('council_moderator'), 'the workflow must never render as a department card');
  });

  test('the run reports complete', async () => {
    const { frames } = await readCouncilStream(proxy.url, { prompt: 'design a login flow' });
    assert.equal(of(frames, 'done').at(-1).data.complete, true);
  });

  test('non-stream /api/council returns the same synthesis', async () => {
    const r = await fetch(`${proxy.url}/api/council`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'design a login flow' }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.text, SYNTHESIS_TEXT);
  });

  test('an empty specialist report does not break the run', async () => {
    const m2 = await startMockVertex({ frameDelayMs: 0, emptySpecialist: 'security_sre' });
    const p2 = await startServer({
      VERTEX_BASE_URL: m2.url,
      GCP_PROJECT: 'test-project', ENGINE_ID: 'e', GOOGLE_ACCESS_TOKEN: 't',
      RATE_LIMIT_PER_MIN: '0',
    });
    try {
      const { frames } = await readCouncilStream(p2.url, { prompt: 'x' });
      assert.equal(of(frames, 'done').at(-1).data.complete, true);
      assert.equal(of(frames, 'synthesis').at(-1).data.text, SYNTHESIS_TEXT);
    } finally { await p2.close(); await m2.close(); }
  });

  test('a mid-stream upstream error surfaces as an error frame, not a silent truncation', async () => {
    const m2 = await startMockVertex({ frameDelayMs: 0, midStreamError: 401 });
    const p2 = await startServer({
      VERTEX_BASE_URL: m2.url,
      GCP_PROJECT: 'test-project', ENGINE_ID: 'e', GOOGLE_ACCESS_TOKEN: 't',
      RATE_LIMIT_PER_MIN: '0',
    });
    try {
      const { frames } = await readCouncilStream(p2.url, { prompt: 'x' });
      assert.equal(of(frames, 'error').length, 1);
      assert.equal(of(frames, 'done').at(-1).data.complete, false);
    } finally { await p2.close(); await m2.close(); }
  });
});

// ---- the caller gate on the proxy --------------------------------------------

describe('proxy mode: caller identity gate', () => {
  let mock, proxy;
  const SECRET = 'test-relay-secret-value';

  before(async () => {
    mock = await startMockVertex({ frameDelayMs: 0 });
    proxy = await startServer({
      VERTEX_BASE_URL: mock.url,
      GCP_PROJECT: 'test-project', ENGINE_ID: 'e', GOOGLE_ACCESS_TOKEN: 't',
      RATE_LIMIT_PER_MIN: '0',
      RELAY_SECRET: SECRET,
    });
  });
  after(async () => { await proxy?.close(); await mock?.close(); });

  test('rejects a caller with no identity', async () => {
    const r = await fetch(`${proxy.url}/api/council`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(r.status, 401);
  });

  test('rejects a caller with the wrong secret', async () => {
    const r = await fetch(`${proxy.url}/api/council`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-secret': 'wrong-length-secret!!' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(r.status, 401);
  });

  test('accepts the correct secret', async () => {
    const r = await fetch(`${proxy.url}/api/council`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-secret': SECRET },
      body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(r.status, 200);
  });

  test('rejects a bearer token that is not a valid Render OIDC assertion', async () => {
    const r = await fetch(`${proxy.url}/api/council`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not.a.jwt' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(r.status, 401);
  });
});

// ---- relay mode (what runs on Render) ----------------------------------------

describe('relay mode: Render holds no Google credential', () => {
  let mock, proxy, relay;
  const SECRET = 'test-relay-secret-value';

  before(async () => {
    mock = await startMockVertex({ frameDelayMs: 5 });
    proxy = await startServer({
      VERTEX_BASE_URL: mock.url,
      GCP_PROJECT: 'test-project', ENGINE_ID: 'e', GOOGLE_ACCESS_TOKEN: 't',
      RATE_LIMIT_PER_MIN: '0',
      RELAY_SECRET: SECRET,
    });
    relay = await startServer({
      UPSTREAM_PROXY_URL: proxy.url,
      RELAY_SECRET: SECRET,
      RATE_LIMIT_PER_MIN: '0',
      // Deliberately present, and deliberately ignored:
      GOOGLE_ACCESS_TOKEN: 'must-not-be-used',
    });
  });
  after(async () => { await relay?.close(); await proxy?.close(); await mock?.close(); });

  test('health reports relay mode and no credential', async () => {
    const j = await (await fetch(`${relay.url}/api/health`)).json();
    assert.equal(j.authMode, 'relay');
    assert.equal(j.configured, true);
    assert.equal(j.upstreamProxy, proxy.url);
  });

  test('the full SSE contract survives the extra hop', async () => {
    const { frames } = await readCouncilStream(relay.url, { prompt: 'design a login flow' });
    assert.ok(of(frames, 'session').length >= 1);
    const keys = [...new Set(of(frames, 'department').map((f) => f.data.key))].sort();
    assert.deepEqual(keys, [...SPECIALISTS].sort());
    assert.ok(of(frames, 'synthesis').length >= 2, 'progressive synthesis must survive the relay');
    assert.equal(of(frames, 'synthesis').at(-1).data.text, SYNTHESIS_TEXT);
    assert.equal(of(frames, 'done').at(-1).data.complete, true);
  });

  test('a proxy rejection reaches the browser as a real HTTP status, not an SSE frame', async () => {
    const badRelay = await startServer({
      UPSTREAM_PROXY_URL: proxy.url,
      RELAY_SECRET: 'wrong-secret-entirely',
      RATE_LIMIT_PER_MIN: '0',
    });
    try {
      const { status, frames } = await readCouncilStream(badRelay.url, { prompt: 'x' });
      assert.equal(status, 401);
      assert.equal(frames.length, 0);
    } finally { await badRelay.close(); }
  });

  test('prompt validation still runs on the relay', async () => {
    const r = await fetch(`${relay.url}/api/council/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    assert.equal(r.status, 400);
  });
});
