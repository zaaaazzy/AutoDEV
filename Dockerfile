FROM node:22.22.3-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Register „Workflow“ der Dokumentation: liest genau diese drei Dateien zur Laufzeit (WORKFLOW_DOCS in
# src/api/workflow-docs.ts). Nicht den ganzen docs-Ordner kopieren: test:full legt dort Videos und Screenshots ab.
COPY docs/laufzeit.md docs/workflows.md docs/agents-und-rechte.md ./docs/
# Nur die API: die Oberfläche baut und liefert der Container aideation_frontend_angular (deploy/frontend).
RUN npx tsc -p tsconfig.json && npm prune --omit=dev
ENV NODE_ENV=production
USER node
EXPOSE 3100
CMD ["npm", "start"]
