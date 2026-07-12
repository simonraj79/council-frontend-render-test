// Playwright config for the cross-platform STREAMING test against the Render-hosted
// front-end. The base URL comes from process.env.RENDER_URL (the
// https://<name>.onrender.com origin). Generous timeouts survive Render free-tier
// cold start (with in-test reload retries) + the council agent streaming run.
const { defineConfig, devices } = require('@playwright/test');

const RENDER_URL = process.env.RENDER_URL || 'http://localhost:8080';

module.exports = defineConfig({
  testDir: './tests',
  // Overall per-test cap: 360s. The test itself budgets up to ~4 cold-start mount
  // attempts (~25s each + reload nav) then up to ~230s for the streaming agent run;
  // the server proxy aborts upstream at 200s, so the browser resolves after.
  timeout: 360 * 1000,
  // High expect timeout so expect.poll / waitFor calls span the streaming window.
  expect: { timeout: 230 * 1000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: RENDER_URL,
    headless: true,
    actionTimeout: 30 * 1000,
    navigationTimeout: 90 * 1000,
    screenshot: 'on',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
