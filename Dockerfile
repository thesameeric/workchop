# syntax=docker/dockerfile:1

# Build the client bundle and the server bundle.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime image: only the server's own dependencies plus the built files.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3001 DATA_DIR=/app/data/offices
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Run as the unprivileged "node" user; /app/data holds offices when no DATABASE_URL is set.
RUN mkdir -p /app/data/offices && chown -R node:node /app/data
USER node
VOLUME /app/data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1
CMD ["node", "dist/server/index.js"]
