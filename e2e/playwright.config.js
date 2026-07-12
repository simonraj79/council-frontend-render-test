// Playwright config for the cross-platform access test against the Render-hosted front-end.
// The base URL comes from process.env.RENDER_URL (the https://<name>.onrender.com origin).
// Generous timeouts survive Render free-tier cold start + council agent cold start.
const { defineConfig, devices } = require('@playwright/test');

const RENDER_URL = process.env.RENDER_URL || 'http://localhost:8080';

module.exports = defineConfig({
  testDir: './tests',
  // Overall per-test cap: 280s (page load + up to ~230s waiting for the agent response;
  // the server proxy aborts upstream at 200s, so the browser resolves shortly after).
  timeout: 280 * 1000,
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
