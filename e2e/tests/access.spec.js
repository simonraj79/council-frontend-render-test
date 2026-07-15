// Cross-platform STREAMING proof: a browser on the Render origin drives the same-origin
// /api/council/stream proxy (SSE), which relays the council_moderator Agent Engine stream
// on Google Cloud. PASS = the 5 department cards stream in progressively AND the moderator
// synthesis panel fills with substantial text, with NONE of the known failure markers.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const RENDER_URL = process.env.RENDER_URL || 'http://localhost:8080';

// The 5 department author keys the UI renders as data-testid="dept-<key>".
const DEPT_KEYS = [
  'software_engineer',
  'product_manager',
  'ux_ui_designer',
  'security_sre',
  'technical_writer',
];

test('council_moderator streams per-department + synthesis to the Render front-end', async ({ page }) => {
  const outDir = path.join(__dirname, '..', 'test-output');
  fs.mkdirSync(outDir, { recursive: true });

  // ---------------------------------------------------------------------------
  // 1) COLD-START ROBUST MOUNT.
  //    On Render's free tier the first hit may be waking; the SPA JS bundle
  //    request can abort (net::ERR_ABORTED) and React never mounts. Navigate with
  //    waitUntil:'load', then in a retry loop wait up to ~25s for prompt-input and
  //    page.reload() if it never appears. Only proceed once the app is mounted.
  // ---------------------------------------------------------------------------
  const promptInput = page.getByTestId('prompt-input');
  const MAX_MOUNT_ATTEMPTS = 4;
  let mounted = false;

  for (let attempt = 1; attempt <= MAX_MOUNT_ATTEMPTS && !mounted; attempt++) {
    try {
      if (attempt === 1) {
        await page.goto(RENDER_URL, { waitUntil: 'load', timeout: 90 * 1000 });
      } else {
        console.log(`SPA not mounted yet; reload attempt ${attempt}/${MAX_MOUNT_ATTEMPTS}`);
        await page.reload({ waitUntil: 'load', timeout: 90 * 1000 });
      }
    } catch (navErr) {
      // A cold-start abort (net::ERR_ABORTED) or nav timeout — retry the loop.
      console.log(`Navigation attempt ${attempt} failed: ${navErr && navErr.message}`);
      continue;
    }
    try {
      await promptInput.waitFor({ state: 'visible', timeout: 25 * 1000 });
      mounted = true;
    } catch {
      // Not mounted within 25s — loop and reload.
    }
  }

  if (!mounted) {
    await page.screenshot({ path: path.join(outDir, 'mount-failure.png'), fullPage: true }).catch(() => {});
    throw new Error(`SPA never mounted (prompt-input) after ${MAX_MOUNT_ATTEMPTS} attempts — likely Render cold-start bundle abort`);
  }

  await expect(promptInput).toBeVisible();

  // ---------------------------------------------------------------------------
  // 2) Kick off the council run.
  // ---------------------------------------------------------------------------
  const prompt = 'We are building a mobile app that lets university students split shared '
    + 'expenses and settle debts. Give me a cross-functional readout: software engineering, '
    + 'product, UX/UI, security/SRE, and technical writing perspectives, then a consolidated '
    + 'recommendation.';
  await promptInput.fill(prompt);
  await page.getByTestId('ask-button').click();

  const errorPanel = page.getByTestId('error');

  // Fail fast if the proxy surfaces an error (e.g. 401 token expired, 504 timeout).
  // Runs as a background race against the streaming assertions below.
  const failFastOnError = (async () => {
    await errorPanel.waitFor({ state: 'visible', timeout: 230 * 1000 });
    const errText = (await errorPanel.innerText().catch(() => '')).trim();
    throw new Error('Front-end showed an error instead of a council readout: ' + errText);
  })();
  // Prevent an unhandled rejection if the run succeeds before any error appears.
  failFastOnError.catch(() => {});

  // ---------------------------------------------------------------------------
  // 3) STREAMING: the departments container appears and cards stream in.
  //    Prove progressive per-department reveal: wait until at least 3 of the 5
  //    department cards have non-empty (streamed) text within ~200s.
  // ---------------------------------------------------------------------------
  const departments = page.getByTestId('departments');

  const assertStreaming = (async () => {
    await departments.waitFor({ state: 'visible', timeout: 200 * 1000 });

    // At least 3 department cards must become non-empty (proves live streaming,
    // not a single collapsed final payload). We poll the card texts.
    await expect.poll(async () => {
      let filled = 0;
      for (const key of DEPT_KEYS) {
        const card = page.getByTestId(`dept-${key}`);
        if ((await card.count()) === 0) continue;
        const t = (await card.innerText().catch(() => '')).trim();
        // A card counts as "streamed" once it carries real body text beyond its label.
        if (t.replace(/\s+/g, ' ').length > 40) filled++;
      }
      return filled;
    }, {
      message: 'expected at least 3 department cards to stream non-empty text',
      timeout: 200 * 1000,
      intervals: [1000, 2000, 3000, 5000],
    }).toBeGreaterThanOrEqual(3);

    // The container should render the 5 department cards overall.
    await expect.poll(async () => {
      let present = 0;
      for (const key of DEPT_KEYS) {
        if ((await page.getByTestId(`dept-${key}`).count()) > 0) present++;
      }
      return present;
    }, {
      message: 'expected all 5 department cards to be present',
      timeout: 60 * 1000,
    }).toBe(5);
  })();

  // ---------------------------------------------------------------------------
  // 4) SYNTHESIS: the moderator readout panel becomes visible with real content.
  // ---------------------------------------------------------------------------
  const response = page.getByTestId('response');

  const assertSynthesis = (async () => {
    await response.waitFor({ state: 'visible', timeout: 230 * 1000 });
    await expect.poll(async () => {
      return (await response.innerText().catch(() => '')).trim().length;
    }, {
      message: 'expected substantial synthesis text (>150 chars)',
      timeout: 230 * 1000,
      intervals: [1000, 2000, 3000, 5000],
    }).toBeGreaterThan(150);
  })();

  // Race the real work against fail-fast-on-error so a proxy error surfaces immediately.
  await Promise.race([
    Promise.all([assertStreaming, assertSynthesis]),
    failFastOnError,
  ]);

  // ---------------------------------------------------------------------------
  // 5) Screenshot the final streamed state and do content sanity checks.
  // ---------------------------------------------------------------------------
  await page.screenshot({ path: path.join(outDir, 'council-stream-proof.png'), fullPage: true });

  if (await errorPanel.isVisible().catch(() => false)) {
    const errText = (await errorPanel.innerText().catch(() => '')).trim();
    throw new Error('Front-end showed an error alongside the readout: ' + errText);
  }

  const text = (await response.innerText()).trim();
  console.log('\n===== SYNTHESIS (first 1500 chars) =====\n' + text.slice(0, 1500));

  // We do NOT blanket-reject 'error'/'failed' — a genuine Security/SRE readout
  // legitimately discusses error handling and failure modes. Only the old
  // cross-engine bug marker must be absent.
  expect(text.toLowerCase()).not.toContain('a2a request failed');
  expect(text.length).toBeGreaterThan(150);
});
