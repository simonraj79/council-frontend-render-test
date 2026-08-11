# Dockerfile — the CLOUD RUN proxy image.
#
# This image is API-ONLY on purpose: it does not build or serve the SPA. The SPA
# is Render's job; the proxy's only job is to hold the Google credential — which
# on Cloud Run means holding nothing at all, because tokens come from the
# metadata server at 169.254.169.254.
#
# server.js detects the absence of client/dist and skips the static routes, so
# the same file runs unmodified in both roles.
#
# Build+deploy with ./deploy-cloudrun.ps1 (or `gcloud run deploy --source .`).

FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so the dependency layer caches across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

# Cloud Run injects PORT (8080 by default); server.js binds 0.0.0.0:$PORT.
EXPOSE 8080

# Run as the non-root user the base image already provides.
USER node

CMD ["node", "server.js"]
