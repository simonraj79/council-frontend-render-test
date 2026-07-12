import { useMemo, useRef, useState } from 'react';
import { marked } from 'marked';

const DEFAULT_PROMPT =
  'Should NTU build a dedicated EV lane on campus? Give me the full council roundtable.';

// Fixed display order + labels for the five council departments. The `key` matches
// the agent event author (event: department -> data.key) so we can slot each
// specialist's output into the right card as it streams in.
const DEPARTMENTS = [
  { key: 'software_engineer', name: 'Software Engineer' },
  { key: 'product_manager', name: 'Product Manager' },
  { key: 'ux_ui_designer', name: 'UX/UI Designer' },
  { key: 'security_sre', name: 'Security & SRE' },
  { key: 'technical_writer', name: 'Technical Writer' },
];

function renderMarkdown(text) {
  if (!text) return '';
  try {
    return marked.parse(text, { breaks: true });
  } catch (e) {
    return '';
  }
}

// Parse a Server-Sent-Events buffer into complete frames. Each frame is separated
// by a blank line ("\n\n") and carries an "event:" line and a "data:" line. We
// return the parsed frames plus whatever partial tail is left in the buffer so the
// caller can prepend it to the next chunk.
function parseSseFrames(buffer) {
  const frames = [];
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) continue;
    let data = null;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch (e) {
      continue;
    }
    frames.push({ event, data });
  }
  return { frames, rest: buffer };
}

export default function App() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Per-department accumulated text, keyed by author (product_manager, etc.).
  const [departments, setDepartments] = useState({});
  const [synthesis, setSynthesis] = useState('');
  const [started, setStarted] = useState(false);
  const abortRef = useRef(null);

  const synthesisHtml = useMemo(() => renderMarkdown(synthesis), [synthesis]);

  async function onAsk() {
    if (loading) return;
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError('Please enter a prompt for the council.');
      setStarted(false);
      setDepartments({});
      setSynthesis('');
      return;
    }

    setLoading(true);
    setError('');
    setDepartments({});
    setSynthesis('');
    setStarted(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/council/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        // The stream endpoint failed before it could open the event stream. Try to
        // surface any JSON error body the server may have sent.
        let msg = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (data && data.error) msg = data.error;
        } catch (e) {
          /* non-JSON body — keep the HTTP status message */
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Read the stream frame by frame, updating the UI as each event lands.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseFrames(buffer);
        buffer = rest;

        for (const { event, data } of frames) {
          if (event === 'department' && data && data.key) {
            setDepartments((prev) => ({
              ...prev,
              [data.key]: { name: data.name, text: data.text || '' },
            }));
          } else if (event === 'synthesis' && data) {
            setSynthesis(data.text || '');
          } else if (event === 'error' && data) {
            setError(
              data.error ? String(data.error) : `Stream error (HTTP ${data.status || '?'})`
            );
          } else if (event === 'done') {
            // Server signalled the end of the stream.
          }
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // User navigated away / component torn down — nothing to report.
      } else {
        setError(String((e && e.message) || e));
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="page">
      <header className="header">
        <h1>Roundtable Council — Render Access Test</h1>
        <p className="subtitle">
          A front-end hosted on Render calling the council_moderator Agent Engine on
          Google Cloud, streaming each department live through a same-origin proxy.
        </p>
      </header>

      <main className="card">
        <label className="label" htmlFor="prompt">
          Your question for the council
        </label>
        <textarea
          id="prompt"
          className="prompt"
          data-testid="prompt-input"
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={loading}
          placeholder="Ask the council anything..."
        />

        <div className="actions">
          <button
            className="ask-button"
            data-testid="ask-button"
            onClick={onAsk}
            disabled={loading}
          >
            {loading ? 'Convening the council…' : 'Ask the Council'}
          </button>
        </div>

        {loading && (
          <div className="loading" data-testid="loading" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>
              Contacting the agent. On the free tier the first request can take up
              to a minute (cold start) — departments will light up as each one
              finishes.
            </span>
          </div>
        )}

        {error && (
          <div className="error" data-testid="error" role="alert">
            <strong>Error:</strong> {error}
          </div>
        )}

        {started && (
          <section className="departments-section">
            <h2 className="section-title">Department roundtable</h2>
            <div className="departments" data-testid="departments">
              {DEPARTMENTS.map(({ key, name }) => {
                const entry = departments[key];
                const filled = !!(entry && entry.text);
                return (
                  <article
                    key={key}
                    className={`dept-card ${filled ? 'is-done' : 'is-waiting'}`}
                    data-testid={`dept-${key}`}
                    data-status={filled ? 'done' : 'waiting'}
                  >
                    <div className="dept-head">
                      <span className="dept-name">{name}</span>
                      <span className="dept-status" aria-hidden="true">
                        {filled ? (
                          <span className="dept-check">✓</span>
                        ) : (
                          <span className="dept-spinner" />
                        )}
                      </span>
                    </div>
                    <div className="dept-body">
                      {filled ? (
                        <div
                          className="markdown"
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdown(entry.text),
                          }}
                        />
                      ) : (
                        <p className="dept-waiting-text">Deliberating…</p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {synthesis && (
          <section className="response" data-testid="response">
            <h2 className="response-title">Chair&rsquo;s Synthesis</h2>
            <div
              className="markdown"
              dangerouslySetInnerHTML={{ __html: synthesisHtml }}
            />
          </section>
        )}
      </main>

      <footer className="footer">
        <span>Cross-platform access proof · Render → Google Cloud Vertex AI Agent Engine</span>
      </footer>
    </div>
  );
}
