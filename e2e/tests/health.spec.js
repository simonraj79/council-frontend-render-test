// Fast API-only health probe of the proxy: GET /api/health must report ok + configured.
// With EXPECT_AUTH_REFRESHABLE=1 it ALSO enforces authRefreshable:true and degraded:false —
// the CI guard that fails the build if someone redeploys the legacy static
// GOOGLE_ACCESS_TOKEN (~1h, non-refreshable, degraded:true) instead of GOOGLE_ADC_JSON.
// NOTE: /api/health hides authMode/project/region/engineId when COUNCIL_API_KEY is set,
// so we assert only the always-present fields: ok, configured, authRefreshable, degraded.
const { test, expect } = require('@playwright/test');

const RENDER_URL = process.env.RENDER_URL || 'http://localhost:8080';

test('/api/health reports a configured (and, when required, refreshable) proxy', async ({ request }) => {
  const res = await request.get(RENDER_URL + '/api/health');
  expect(res.ok(), `GET /api/health returned HTTP ${res.status()}`).toBe(true);

  const json = await res.json();
  expect(json.configured, 'health.configured must be true (credential env var present and parseable)').toBe(true);

  if (process.env.EXPECT_AUTH_REFRESHABLE === '1') {
    // Guard against the legacy static-token deployment sneaking back in.
    expect(json.authRefreshable, 'health.authRefreshable must be true — deploy GOOGLE_ADC_JSON, not GOOGLE_ACCESS_TOKEN').toBe(true);
    expect(json.degraded, 'health.degraded must be false — static ~1h tokens are not acceptable').toBe(false);
  }
});
