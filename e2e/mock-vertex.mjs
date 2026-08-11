// mock-vertex.mjs — an offline stand-in for the Vertex AI Reasoning Engine REST
// API, used via the VERTEX_BASE_URL test hook.
//
// The event stream below is NOT invented. It reproduces the shapes observed in
// live session 8602554992622043136 against engine 8893446530510356480 after the
// 2026-07-16 redeploy that split the workflow into two nodes:
//
//   author=software_engineer  path=council_moderator@1/consult_specialists@1/software_engineer@1
//   ... x5 specialists, each with output_for = [its own path]
//   author=council_moderator  path=council_moderator@1/consult_specialists@1     (EMPTY text)
//   author=council_chair      path=council_moderator@1/chair_decision@1/council_chair@1   <- SYNTHESIS
//   author=council_moderator  path=council_moderator@1/chair_decision@1          (SAME text again)
//
// Two properties of that trace are what the proxy has to get right:
//   * the synthesis is authored `council_chair`, not `council_moderator`
//   * it arrives TWICE and must not be concatenated with itself
//
// A specialist returning empty text is also a real observed failure mode
// (session 8602554992622043136 had one), so it is reproducible here on demand.

import http from 'node:http';

export const SPECIALISTS = [
  'software_engineer',
  'product_manager',
  'ux_ui_designer',
  'security_sre',
  'technical_writer',
];

export const SYNTHESIS_TEXT =
  'Council synthesis: ship the smallest correct thing first, then harden. ' +
  'The engineering and security views agree that the credential boundary is the ' +
  'decisive design constraint; the product and UX views agree the latency budget ' +
  'is the decisive user constraint. Recommend proceeding.';

function evt({ author, path, text, partial = false, outputFor = true }) {
  const node_info = { path };
  if (outputFor) node_info.output_for = [path];
  return {
    author,
    content: { parts: [{ text }] },
    node_info,
    partial,
  };
}

// The full trace, in emission order.
export function councilTrace({ emptySpecialist = null } = {}) {
  const frames = [];
  for (const name of SPECIALISTS) {
    const text = name === emptySpecialist ? '' : `${name} report: two paragraphs of considered analysis about the request, with enough length to clear the streaming assertions used by the e2e suite.`;
    frames.push(evt({
      author: name,
      path: `council_moderator@1/consult_specialists@1/${name}@1`,
      text,
    }));
  }
  // The zero-text node echo the workflow emits when the fan-out node closes.
  frames.push(evt({
    author: 'council_moderator',
    path: 'council_moderator@1/consult_specialists@1',
    text: '',
    outputFor: false,
  }));
  // THE SYNTHESIS — authored by the chair agent, nested under chair_decision.
  frames.push(evt({
    author: 'council_chair',
    path: 'council_moderator@1/chair_decision@1/council_chair@1',
    text: SYNTHESIS_TEXT,
  }));
  // The terminal echo: identical text, authored by the workflow itself.
  frames.push(evt({
    author: 'council_moderator',
    path: 'council_moderator@1/chair_decision@1',
    text: SYNTHESIS_TEXT,
    outputFor: false,
  }));
  return frames;
}

/**
 * Start the mock. Options:
 *   frameDelayMs   pause between SSE frames (proves PROGRESSIVE delivery)
 *   emptySpecialist name of a specialist that returns empty text
 *   failStreamWith  HTTP status to fail :streamQuery with
 *   midStreamError  emit an {error:{...}} payload after the specialists
 */
export function startMockVertex(opts = {}) {
  const {
    frameDelayMs = 5,
    emptySpecialist = null,
    failStreamWith = 0,
    midStreamError = 0,
  } = opts;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    await new Promise((r) => { req.on('end', r); req.resume(); });

    if (url.pathname.endsWith(':query')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ output: { id: 'mock-session-0001' } }));
    }

    if (url.pathname.endsWith(':streamQuery')) {
      if (failStreamWith) {
        res.writeHead(failStreamWith, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: failStreamWith, status: 'MOCK_FAILURE' } }));
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const frames = councilTrace({ emptySpecialist });
      for (let i = 0; i < frames.length; i++) {
        if (midStreamError && i === SPECIALISTS.length) {
          res.write('data: ' + JSON.stringify({ error: { code: midStreamError, status: 'MOCK_MID_STREAM' } }) + '\n\n');
          return res.end();
        }
        res.write('data: ' + JSON.stringify(frames[i]) + '\n\n');
        if (frameDelayMs) await new Promise((r) => setTimeout(r, frameDelayMs));
      }
      return res.end();
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock: unhandled path ' + url.pathname }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Allow running standalone: `node e2e/mock-vertex.mjs`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const m = await startMockVertex();
  console.log('mock vertex listening at', m.url);
}
