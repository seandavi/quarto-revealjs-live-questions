# syntax=docker/dockerfile:1

# Build: bundle the Node server and the audience page script with Bun.
# The output is plain JavaScript, so this stage runs on the build host's own
# platform and a multi-platform build bundles once, without emulating Bun.
FROM --platform=$BUILDPLATFORM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
# Runtime dependencies are all the bundler needs (no wrangler/workerd).
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
RUN bun run build:audience && bun run build:node

# Run: plain Node. dist/server.js is self-contained, so no node_modules.
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
