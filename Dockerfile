FROM node:22.22.3-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Register „Workflow“ der Dokumentation: liest docs/*.md zur Laufzeit.
COPY docs ./docs
# Nur die API: die Oberfläche baut und liefert der Container devlog_frontend_angular (deploy/frontend).
RUN npx tsc -p tsconfig.json && npm prune --omit=dev
ENV NODE_ENV=production
USER node
EXPOSE 3100
CMD ["npm", "start"]
