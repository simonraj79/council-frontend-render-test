import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const DEFAULT_PROMPT =
  'Should NTU build a dedicated EV lane on campus? Give me the full council roundtable.';

// Fixed display order + labels for the five council departments. The `key` matches
// the agent event author (event: department -> data.key) so we can slot each
// specialist's output into the right card as it streams in. Unknown keys the
// server relays (renamed/added specialists) are rendered dynamically after these.
const DEPARTMENTS = [
  { key: 'software_engineer', name: 'Software Engineer' },
  { key: 'product_manager', name: 'Product Manager' },
  { key: 'ux_ui_designer', name: 'UX/UI Designer' },
  { key: 'security_sre', name: 'Security & SRE' },
  { key: 'technical_writer', name: 'Technical Writer' },
];

const KNOWN_KEYS = new Set(DEPARTMENTS.map((d) => d.key));

const API_KEY_STORAGE = 'council_api_key'; // localStorage — survives the tab
const SESSION_STORAGE = 'council_session'; // sessionStorage — one conversation per tab
const WATCHDOG_MS = 90000; // abort if the stream goes silent this long
const RETRY_DELAYS = [1000, 3000]; // pre-frame auto-retry backoff

function renderMarkdown(text) {
  if (!text) return '';
  try {
    // Sanitize the generated HTML: the markdown comes from an LLM stream and
    // must never be able to inject script into the page.
    return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
  } catch (e) {
    return '';
  }
}

function getStoredApiKey() {
  try {
    return localStorage.getItem(API_KEY_STORAGE) || '';
  } catch (e) {
    return '';
  }
}

function getStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && typeof s.userId === 'string' ? s : null;
  } catch (e) {
    return null;
  }
}

// Map a pre-stream HTTP failure to a friendly message (and whether the access-key
// input should be revealed).
function describeHttpError(status, serverMsg) {
  const msg = serverMsg || '';
  if (status === 401 && /x-council-key/i.test(msg)) {
    return {
      message: 'This deployment requires an access key. Enter it below and ask again.',
      needsKey: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      message:
        "The server's Google credential has expired or lacks access — the operator must refresh GOOGLE_ADC_JSON.",
    };
  }
  if (status === 413) {
    return { message: 'That prompt is too long for the council — please shorten it and try again.' };
  }
  if (status === 429) {
    return { message: 'The council is busy or rate-limited right now — please try again shortly.' };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { message: 'The server appears to be waking from a cold start — please retry in about 30 seconds.' };
  }
  return { message: msg || `HTTP ${status}` };
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function App() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Per-department accumulated text, keyed by author (product_manager, etc.).
  const [departments, setDepartments] = useState({});
  const [synthesis, setSynthesis] = useState('');
  const [started, setStarted] = useState(false);
  // Retry button shown after a recoverable mid-stream drop / incomplete run.
  const [canRetry, setCanRetry] = useState(false);
  // Access key (x-council-key). The input is revealed after a key-gated 401, and
  // stays visible once a key is stored.
  const [apiKey, setApiKey] = useState(getStoredApiKey);
  const [needsKey, setNeedsKey] = useState(false);
  const [hasSession, setHasSession] = useState(() => Boolean(getStoredSession()));

  const abortRef = useRef(null);
  const runIdRef = useRef(0); // increments per ask so superseded runs go silent
  const userCancelRef = useRef(false);
  const sessionRef = useRef(getStoredSession());

  // Abort any in-flight stream when the component unmounts.
  useEffect(() => {
    return () => {
      userCancelRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  const synthesisHtml = useMemo(() => renderMarkdown(synthesis), [synthesis]);

  function persistSession(data) {
    if (!data || typeof data.userId !== 'string' || !data.userId) return;
    const s = { userId: data.userId, sessionId: data.sessionId || null };
    sessionRef.current = s;
    try {
      sessionStorage.setItem(SESSION_STORAGE, JSON.stringify(s));
    } catch (e) {
      /* storage unavailable — session still lives in memory */
    }
    setHasSession(true);
  }

  function onKeyChange(e) {
    const v = e.target.value;
    setApiKey(v);
    try {
      if (v) localStorage.setItem(API_KEY_STORAGE, v);
      else localStorage.removeItem(API_KEY_STORAGE);
    } catch (err) {
      /* storage unavailable — key still lives in state */
    }
  }

  function onNewConversation() {
    sessionRef.current = null;
    try {
      sessionStorage.removeItem(SESSION_STORAGE);
    } catch (e) {
      /* ignore */
    }
    setHasSession(false);
    setDepartments({});
    setSynthesis('');
    setError('');
    setStarted(false);
    setCanRetry(false);
  }

  function onCancel() {
    userCancelRef.current = true;
    abortRef.current?.abort();
  }

  // merge=true (Retry) keeps the department cards already rendered and lets the
  // server's accumulated-text department events overwrite them safely.
  async function onAsk(merge = false) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError('Please enter a prompt for the council.');
      setStarted(false);
      setDepartments({});
      setSynthesis('');
      return;
    }

    // Supersede any previous run before starting a new one.
    abortRef.current?.abort();
    const runId = ++runIdRef.current;
    const alive = () => runIdRef.current === runId;
    userCancelRef.current = false;

    setLoading(true);
    setError('');
    setCanRetry(false);
    if (!merge) {
      setDepartments({});
      setSynthesis('');
    }
    setStarted(true);

    try {
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        abortRef.current = controller;

        let frameSeen = false; // any SSE frame parsed => never auto-retry
        let stalled = false;
        let watchdog = null;

        try {
          const body = { prompt: trimmed };
          const sess = sessionRef.current;
          if (sess && sess.userId) {
            body.userId = sess.userId;
            if (sess.sessionId) body.sessionId = sess.sessionId;
          }
          const headers = { 'content-type': 'application/json' };
          const key = getStoredApiKey() || apiKey;
          if (key) headers['x-council-key'] = key;

          const res = await fetch('/api/council/stream', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!res.ok || !res.body) {
            // The stream endpoint failed before it could open the event stream —
            // the server sends plain HTTP JSON {error} with a real status code.
            let serverMsg = '';
            try {
              const data = await res.json();
              if (data && data.error) serverMsg = String(data.error);
            } catch (e) {
              /* non-JSON body — keep the HTTP status message */
            }
            const err = new Error(serverMsg || `HTTP ${res.status}`);
            err.httpStatus = res.status;
            throw err;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let sawDone = false;
          let doneComplete = false;
          let streamErrorMsg = '';

          // Inactivity watchdog: if the stream goes silent for WATCHDOG_MS we
          // abort instead of hanging forever on a dead connection.
          const armWatchdog = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => {
              stalled = true;
              controller.abort();
            }, WATCHDOG_MS);
          };
          armWatchdog();

          // Read the stream frame by frame, updating the UI as each event lands.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { value, done } = await reader.read();
            armWatchdog();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = parseSseFrames(buffer);
            buffer = rest;

            for (const { event, data } of frames) {
              frameSeen = true;
              if (!alive()) return;
              if (event === 'session' && data) {
                // Persist {userId, sessionId} so follow-up asks continue the
                // same multi-turn conversation.
                persistSession(data);
              } else if (event === 'department' && data && data.key) {
                setDepartments((prev) => ({
                  ...prev,
                  [data.key]: { name: data.name || data.key, text: data.text || '' },
                }));
              } else if (event === 'synthesis' && data) {
                setSynthesis(data.text || '');
              } else if (event === 'error' && data) {
                streamErrorMsg = data.error
                  ? String(data.error)
                  : `Stream error (HTTP ${data.status || '?'})`;
              } else if (event === 'done' && data) {
                sawDone = true;
                doneComplete = Boolean(data.complete);
              }
            }
          }
          clearTimeout(watchdog);

          if (!alive()) return;
          if (streamErrorMsg) {
            setError(streamErrorMsg);
            setCanRetry(true);
          } else if (!sawDone || !doneComplete) {
            // done.complete === false, or the stream ended without a done frame.
            setError('The council run ended before completing — you may retry.');
            setCanRetry(true);
          }
          return; // run finished (successfully or with a reported stream error)
        } catch (e) {
          clearTimeout(watchdog);
          if (!alive()) return; // superseded by a newer ask

          if (e && e.name === 'AbortError') {
            if (userCancelRef.current) return; // user hit Cancel / page torn down
            if (stalled) {
              if (!frameSeen && attempt < RETRY_DELAYS.length) {
                await sleep(RETRY_DELAYS[attempt]);
                if (!alive()) return;
                continue; // pre-frame stall — auto-retry with backoff
              }
              setError(
                frameSeen
                  ? 'Stream stalled — no data received for 90 seconds. Connection lost; the departments shown so far are kept.'
                  : 'Stream stalled — no data received for 90 seconds.'
              );
              setCanRetry(true);
              return;
            }
            return; // other aborts (unmount) — nothing to report
          }

          const httpStatus = e && e.httpStatus;
          const isNetwork = !httpStatus && (e instanceof TypeError || (e && e.name === 'TypeError'));
          const autoRetryable =
            isNetwork || httpStatus === 502 || httpStatus === 503 || httpStatus === 504;

          if (!frameSeen && autoRetryable && attempt < RETRY_DELAYS.length) {
            await sleep(RETRY_DELAYS[attempt]);
            if (!alive()) return;
            continue; // failed before any SSE frame — auto-retry with backoff
          }

          if (frameSeen) {
            // Mid-stream drop: KEEP the departments already rendered.
            setError('Connection lost — the departments shown so far are kept. You may retry.');
            setCanRetry(true);
          } else if (httpStatus) {
            const info = describeHttpError(httpStatus, e.message);
            setError(info.message);
            if (info.needsKey) setNeedsKey(true);
            if (autoRetryable || httpStatus === 429) setCanRetry(true);
          } else if (isNetwork) {
            setError('Could not reach the server — check your connection and try again.');
            setCanRetry(true);
          } else {
            setError(String((e && e.message) || e));
          }
          return;
        }
      }
    } finally {
      if (alive()) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }

  // Known five cards in fixed order, then any unknown department keys the server
  // relayed (using the display name carried on the event), in arrival order.
  const extraDepartments = Object.keys(departments)
    .filter((key) => !KNOWN_KEYS.has(key))
    .map((key) => ({ key, name: departments[key].name || key }));
  const allDepartments = [...DEPARTMENTS, ...extraDepartments];

  const showKeyInput = needsKey || Boolean(apiKey);

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

        {showKeyInput && (
          <div className="key-row">
            <label className="label" htmlFor="council-key">
              Access key
            </label>
            <input
              id="council-key"
              className="key-input"
              data-testid="key-input"
              type="password"
              value={apiKey}
              onChange={onKeyChange}
              disabled={loading}
              placeholder="x-council-key value"
              autoComplete="off"
            />
            <p className="key-hint">
              Stored only in this browser and sent as the x-council-key header.
            </p>
          </div>
        )}

        <div className="actions">
          <button
            className="ask-button"
            data-testid="ask-button"
            onClick={() => onAsk(false)}
            disabled={loading}
          >
            {loading ? 'Convening the council…' : 'Ask the Council'}
          </button>
          {loading && (
            <button
              className="secondary-button"
              data-testid="cancel-button"
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
          {!loading && canRetry && (
            <button
              className="secondary-button"
              data-testid="retry-button"
              onClick={() => onAsk(true)}
            >
              Retry
            </button>
          )}
          {!loading && (hasSession || started) && (
            <button
              className="secondary-button"
              data-testid="new-conversation-button"
              onClick={onNewConversation}
            >
              New conversation
            </button>
          )}
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
              {allDepartments.map(({ key, name }) => {
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
                      <span className="dept-name">{(entry && entry.name) || name}</span>
                      <span className="dept-status" aria-hidden="true">
                        {filled ? (
                          <span className="dept-check">✓</span>
                        ) : loading ? (
                          <span className="dept-spinner" />
                        ) : null}
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
                      ) : loading ? (
                        <p className="dept-waiting-text">Deliberating…</p>
                      ) : (
                        <p className="dept-noresponse-text">No response</p>
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
