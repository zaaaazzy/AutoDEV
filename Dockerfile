FROM node:22.22.3-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 3100
CMD ["npm", "start"]
