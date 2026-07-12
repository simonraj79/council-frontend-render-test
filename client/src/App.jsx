import { useMemo, useState } from 'react';
import { marked } from 'marked';

const DEFAULT_PROMPT =
  'Should NTU build a dedicated EV lane on campus? Give me the full council roundtable.';

// The browser only ever talks to its OWN origin (/api/council). The Express server
// holds the Google access token and proxies to the Agent Engine, so there is no CORS.
async function askCouncil(prompt) {
  const res = await fetch('/api/council', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
  }
  return data;
}

export default function App() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');

  const answerHtml = useMemo(() => {
    if (!answer) return '';
    try {
      return marked.parse(answer, { breaks: true });
    } catch (e) {
      return '';
    }
  }, [answer]);

  async function onAsk() {
    if (loading) return;
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError('Please enter a prompt for the council.');
      setAnswer('');
      return;
    }
    setLoading(true);
    setError('');
    setAnswer('');
    try {
      const data = await askCouncil(trimmed);
      if (data && data.text) {
        setAnswer(data.text);
      } else if (data && data.error) {
        setError(data.error);
      } else {
        setError('The council returned an empty response.');
      }
    } catch (e) {
      setError(String((e && e.message) || e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <h1>Roundtable Council — Render Access Test</h1>
        <p className="subtitle">
          A front-end hosted on Render calling the council_moderator Agent Engine on
          Google Cloud, through a same-origin proxy.
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
              to a minute (cold start) — hang tight.
            </span>
          </div>
        )}

        {error && (
          <div className="error" data-testid="error" role="alert">
            <strong>Error:</strong> {error}
          </div>
        )}

        {answer && (
          <section className="response" data-testid="response">
            <h2 className="response-title">Council readout</h2>
            <div
              className="markdown"
              dangerouslySetInnerHTML={{ __html: answerHtml }}
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
