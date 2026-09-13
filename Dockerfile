FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/router/package.json packages/router/package.json
RUN npm ci

COPY packages/router packages/router
RUN ./node_modules/.bin/tsc -p /app/packages/router/tsconfig.json

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/router-data
ENV ROUTER_PORT=3000

COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/router/package.json packages/router/package.json
RUN npm ci --omit=dev --workspace @yu_robotics/remote-cli-router --include-workspace-root=false

COPY --from=build /app/packages/router/dist packages/router/dist
COPY --from=build /app/packages/router/bin packages/router/bin

RUN mkdir -p /router-data && chown -R node:node /app /router-data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.ROUTER_PORT || '3000') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "packages/router/dist/cli.js"]
CMD ["start"]
