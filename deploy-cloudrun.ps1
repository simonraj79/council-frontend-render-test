# deploy-cloudrun.ps1 — deploy the KEYLESS council proxy to Cloud Run.
#
# Why Cloud Run at all: Agent Engine needs a Google OAuth token and sends no CORS
# headers, so something server-side must authenticate. On Cloud Run that
# something stores nothing: the metadata server mints short-lived tokens for the
# attached service account on demand. No key file, no refresh token, no rotation.
#
# This is the closest self-service equivalent to the Workload Identity Federation
# pattern in "Secure Access to Google Gemini from Microsoft Azure Without API
# Keys". The literal WIF pattern (Render OIDC -> sts.googleapis.com -> service
# account) additionally needs an admin to create the workload identity pool;
# see adk-agent-skills/10-render-oidc-keyless.md.
#
# Required IAM (verified present 2026-08-11): roles/run.admin,
# roles/iam.serviceAccountUser (actAs on the runtime SA), roles/storage.admin +
# roles/cloudbuild.builds.editor + roles/artifactregistry.editor for the build.

[CmdletBinding()]
param(
  [string]$Project     = 've-grp-1-333-project3-9rqd',
  [string]$Region      = 'us-central1',
  [string]$Service     = 'council-proxy',
  [string]$EngineId    = '8893446530510356480',
  # The runtime identity. This SA already holds roles/aiplatform.user on the
  # project, which is what grants aiplatform.reasoningEngines.query.
  [string]$RuntimeSa   = '1056960165012-compute@developer.gserviceaccount.com',
  # Render workspace issuer + the subject allowed to call this proxy.
  [string]$OidcIssuer  = 'https://oidc.render.com/tea-csps46i3esus73eojjp0',
  [string]$OidcAudience = 'sts.amazonaws.com',
  [string]$AllowedSubs = '',
  # Bring-up fallback while the OIDC subject is still unknown. Drop it after.
  [string]$RelaySecret = ''
)

$ErrorActionPreference = 'Stop'

if (-not $RelaySecret) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $RelaySecret = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', ''
  Write-Host "Generated RELAY_SECRET (set this on the Render service too):" -ForegroundColor Yellow
  Write-Host "  $RelaySecret"
}

# NOTE: no GOOGLE_ADC_JSON / GOOGLE_SA_KEY_JSON / GOOGLE_ACCESS_TOKEN here, and
# there never should be. The absence of a credential env var IS the design.
$envPairs = @(
  "GCP_PROJECT=$Project"
  "GCP_REGION=$Region"
  "ENGINE_ID=$EngineId"
  "RENDER_OIDC_ISSUER=$OidcIssuer"
  "RENDER_OIDC_AUDIENCE=$OidcAudience"
  "RELAY_SECRET=$RelaySecret"
  "RATE_LIMIT_PER_MIN=0"
  "MAX_INFLIGHT=3"
  "UPSTREAM_TIMEOUT_MS=200000"
)
if ($AllowedSubs) { $envPairs += "RENDER_ALLOWED_SUBS=$AllowedSubs" }

# '^' is the delimiter override: Cloud Run service accounts and OIDC subjects
# both contain commas/colons that the default parser would split on.
$envArg = '^;;^' + ($envPairs -join ';;')

Write-Host "Deploying $Service to $Region in $Project ..." -ForegroundColor Cyan

gcloud run deploy $Service `
  --source . `
  --project $Project `
  --region $Region `
  --service-account $RuntimeSa `
  --allow-unauthenticated `
  --min-instances 0 `
  --max-instances 4 `
  --memory 512Mi `
  --cpu 1 `
  --timeout 300 `
  --port 8080 `
  --set-env-vars $envArg

if ($LASTEXITCODE -ne 0) { throw "gcloud run deploy failed with exit code $LASTEXITCODE" }

$url = gcloud run services describe $Service --project $Project --region $Region --format 'value(status.url)'
Write-Host ""
Write-Host "Proxy URL: $url" -ForegroundColor Green
Write-Host "Set UPSTREAM_PROXY_URL=$url on the Render service."
Write-Host ""
Write-Host "Verify it is keyless (expect authMode: metadata-adc):"
Write-Host "  curl `"$url/api/health`""
