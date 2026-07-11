# hadrontool-gmail — Gmail email tool.
#
# Built by Komodo from this repo's `main`, pushed to GHCR, deployed on the
# `komodo_default` network. The operations plane is INTERNAL-ONLY —
# hadron-server reaches it by container name at http://hadrontool-gmail:8080.
# ONE route needs public ingress: a Traefik router + Cloudflare DNS must
# expose /webhooks/gmail so the Cloud Pub/Sub push subscription can deliver
# Gmail watch notifications. Route ONLY that path publicly, and configure the
# push endpoint URL with ?token=<PUBSUB_VERIFICATION_TOKEN>.
#
# Secrets are injected at runtime by Doppler (`doppler run --`), matching the
# other Hadron services — Komodo sets only DOPPLER_TOKEN.
FROM node:22-slim

WORKDIR /app

# Doppler CLI for runtime secret injection (same pattern as the other
# services). No openssl needed: Prisma 7 is engine-less (pg driver adapter).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -sLf --retry 3 --tlsv1.2 --proto '=https' 'https://cli.doppler.com/install.sh' | sh \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080

# Reproducible install from the committed lockfile, then compile and drop dev
# deps. --include=dev because NODE_ENV=production would otherwise skip
# typescript/prisma and the build would fail.
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build && npm prune --omit=dev

USER node

EXPOSE 8080
# Doppler injects GMAIL_TOOL_TOKEN / DATABASE_URL / TOKEN_ENCRYPTION_KEY /
# GOOGLE_* / PUBSUB_* / CORE_EVENTS_* via DOPPLER_TOKEN.
CMD ["doppler", "run", "--", "node", "dist/index.js"]
