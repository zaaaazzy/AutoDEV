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
RUN npm run build:ui

FROM nginx:1.27.3-alpine
COPY deploy/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/frontend/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist/ui/browser /usr/share/nginx/html
EXPOSE 8080
