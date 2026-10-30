# Sandbox für Agents (src/core/sandbox.ts, Schalter DEV_LOG_AGENT_SANDBOX=docker): ein kurzlebiger Container je
# Agent-Lauf. Eingebunden wird nur der Worktree des Auftrags (/workspace) und node_modules als Volume je Projekt.
# Gebaut aus dem Wurzelordner: docker build -t aideation-agent -f deploy/agent/Dockerfile .

# Wächter (agent-guard.ts) als eine Datei bündeln: der PreToolUse-Hook prüft auch im Container jeden Zugriff.
FROM node:22.22.3-bookworm-slim AS guard
WORKDIR /build
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm rebuild esbuild
COPY src ./src
# pg & Co. sind CommonJS: im ESM-Bündel braucht ihr require() ein echtes require.
RUN npx --no-install esbuild src/agent/agent-guard.ts --bundle --platform=node --format=esm --target=node22 \
      --banner:js="import { createRequire as aideationRequire } from 'node:module'; const require = aideationRequire(import.meta.url);" \
      --outfile=/out/agent-guard.mjs
# Egress-Proxy des Agent-Netzwerks (nur Node-Bordmittel) und Vorschau-Aufnahme des visuellen Testers (Playwright aus
# diesem Image statt vom Host).
RUN npx --no-install esbuild src/core/egress-proxy.ts --bundle --platform=node --format=esm --target=node22 \
      --outfile=/out/egress-proxy.mjs \
    && npx --no-install esbuild src/runner/visual-capture-cli.ts --bundle --platform=node --format=esm --target=node22 \
      --external:playwright --outfile=/out/visual-capture.mjs

FROM node:22.22.3-bookworm-slim AS node

# Browser und ihre Systembibliotheken für Playwright-Tests im Projekt.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
# Node 22 in derselben Version wie Worker und API (.nvmrc), unabhängig von der Node-Version des Basis-Images.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
# Claude-CLI in fester Version: ein Update kommt nur mit einem neuen Image, nicht still zur Laufzeit.
ARG CLAUDE_CODE_VERSION=2.1.302
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    HOME=/home/agent
# Playwright in derselben Version wie die Browser des Basis-Images (für die Vorschau-Aufnahme des visuellen Testers).
ARG PLAYWRIGHT_VERSION=1.64.1
# Der Build läuft als root mit HOME=/home/agent: ohne das rm gehört /home/agent/.npm root, und npm/npx im Container
# (andere UID) scheitern mit EACCES. Zur Laufzeit liegt der npm-Cache ohnehin unter /tmp (sandbox.ts).
RUN npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "playwright@${PLAYWRIGHT_VERSION}" \
    && npm cache clean --force \
    && rm -rf /home/agent/.npm /root/.npm
COPY --from=guard /out/agent-guard.mjs /out/egress-proxy.mjs /out/visual-capture.mjs /opt/aideation/
# ESM-Bündel lösen „playwright“ über node_modules neben sich auf: dort liegen die global installierten Pakete.
RUN ln -s /usr/local/lib/node_modules /opt/aideation/node_modules
# Ohne root: Der Container läuft mit der UID des Worker-Benutzers (--user), die hier keinen Eintrag hat. Home und
# Arbeitsordner sind darum für alle beschreibbar; der Container ist kurzlebig (--rm), nichts bleibt liegen.
RUN mkdir -p /home/agent /workspace && chmod 1777 /home/agent /workspace
USER pwuser
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["claude", "--version"]
