# aideation_frontend_angular: Angular-Oberfläche bauen und mit nginx ausliefern.
FROM node:22.22.3-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json angular.json ./
COPY frontend ./frontend
RUN npm run build:ui

FROM nginx:1.27.3-alpine
COPY deploy/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/frontend/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist/ui/browser /usr/share/nginx/html
EXPOSE 8080
