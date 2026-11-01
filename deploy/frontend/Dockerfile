# aideation_frontend_angular: Angular-Oberfläche bauen und mit nginx ausliefern.
FROM node:22.22.3-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json angular.json ./
COPY frontend ./frontend
# Gemeinsame Messung der Überbreite (Diagnose im Browser und visuelle Prüfung des Workers).
COPY src/core/layout-measure.ts ./src/core/layout-measure.ts
# Zeitpläne der Routinen (Cron lesen und beschreiben) – dieselbe Logik wie im Planer des Servers.
COPY src/core/cron.ts ./src/core/cron.ts
# Erlaubte Statuswechsel und Sprint-Zuordnung von Aufträgen – dieselbe Tabelle wie in PATCH /development/:id.
COPY src/core/development-transitions.ts ./src/core/development-transitions.ts
# Sprint-Regeln (Statuswechsel, Löschen, Abschluss) – dieselben wie in PATCH/DELETE /sprints/:id.
COPY src/core/sprint-rules.ts ./src/core/sprint-rules.ts
# Gemeinsame Typen (Status, Budget, Modell-Routing) und defined() – siehe CLAUDE.md, „Gemeinsame Typen“.
COPY src/core/status.ts ./src/core/status.ts
COPY src/core/shared-types.ts ./src/core/shared-types.ts
COPY src/core/defined.ts ./src/core/defined.ts
RUN npm run build:ui

# Ohne root schon im Master-Prozess: PID-Datei und Zwischenablagen unter /tmp, damit läuft der Container auch mit
# read_only (docker-compose.yml, /tmp als tmpfs). Port 8080/8081 braucht kein root.
FROM nginxinc/nginx-unprivileged:1.31.7-alpine
COPY deploy/frontend/nginx.conf /etc/nginx/conf.d/default.conf
# Ausserhalb von conf.d: wird nur in den server-Blöcken von nginx.conf eingebunden.
COPY deploy/frontend/app-locations.conf /etc/nginx/app-locations.conf
COPY deploy/frontend/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist/ui/browser /usr/share/nginx/html
USER nginx
# 8080: direkter Zugriff (Host-Port), 8081: nur Caddy (siehe nginx.conf).
EXPOSE 8080 8081
