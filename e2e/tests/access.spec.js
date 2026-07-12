// Cross-platform access proof: a browser on the Render origin drives the same-origin
// /api/council proxy, which reaches the council_moderator Agent Engine on Google Cloud.
// PASS = the response panel fills with non-empty synthesized text and contains NONE of
// the known failure markers.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const RENDER_URL = process.env.RENDER_URL;

test('council_moderator is reachable from the Render-hosted front-end', async ({ page }) => {
  test.skip(!RENDER_URL, 'RENDER_URL env var is not set');

  const outDir = path.join(__dirname, '..', 'test-output');
  fs.mkdirSync(outDir, { recursive: true });

  // 1) Load the Render-hosted SPA (different platform from the agent).
  await page.goto(RENDER_URL, { waitUntil: 'domcontentloaded', timeout: 90 * 1000 });

  // 2) The UI must expose the prompt input and ask button.
  const promptInput = page.getByTestId('prompt-input');
  await expect(promptInput).toBeVisible({ timeout: 30 * 1000 });

  const prompt = 'We are building a mobile app that lets university students split shared '
    + 'expenses and settle debts. Give me a cross-functional readout: software engineering, '
    + 'product, UX/UI, security/SRE, and technical writing perspectives, then a consolidated '
    + 'recommendation.';
  await promptInput.fill(prompt);

  await page.getByTestId('ask-button').click();

  // 3) Wait (generously) for EITHER the response panel OR the error panel to appear.
  //    The response renders only after the /api/council fetch resolves, which covers
  //    Render free-tier cold start + the in-process council run (tens of seconds).
  const response = page.getByTestId('response');
  const errorPanel = page.getByTestId('error');
  await Promise.race([
    response.waitFor({ state: 'visible', timeout: 230 * 1000 }),
    errorPanel.waitFor({ state: 'visible', timeout: 230 * 1000 }),
  ]);

  // Always screenshot the outcome.
  await page.screenshot({ path: path.join(outDir, 'council-access-proof.png'), fullPage: true });

  // If the proxy surfaced an error (e.g. 401 token expired, 504 timeout), fail with it.
  if (await errorPanel.isVisible()) {
    const errText = (await errorPanel.innerText()).trim();
    throw new Error('Front-end showed an error instead of a council readout: ' + errText);
  }

  await expect(response).toBeVisible();
  const text = (await response.innerText()).trim();
  console.log('\n===== RESPONSE (first 1500 chars) =====\n' + text.slice(0, 1500));

  // 4) Assert it is a real synthesized council readout.
  //    (We do NOT blanket-reject 'error'/'failed' — a genuine Security/SRE readout
  //     legitimately discusses error handling and failure modes. The response panel
  //     rendering at all already means the proxy reached the agent successfully.)
  const lower = text.toLowerCase();
  expect(lower).not.toContain('a2a request failed'); // the old cross-engine bug must be gone
  expect(text.length).toBeGreaterThan(150);          // substantial synthesis, not a stub
});
