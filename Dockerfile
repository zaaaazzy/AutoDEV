FROM node:22.22.3-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY angular.json ./
COPY frontend ./frontend
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
USER node
EXPOSE 3100
CMD ["npm", "start"]
