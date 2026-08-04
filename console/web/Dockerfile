FROM node:24.11.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# As in api/Dockerfile: every workspace manifest must exist for npm ci.
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
COPY api/package.json api/
RUN npm ci --include=dev --workspace @console/shared --workspace @console/web --include-workspace-root
COPY packages/shared packages/shared
RUN npm run build --workspace @console/shared

# Development: the Vite dev server, with web/src bind-mounted over this copy.
FROM deps AS dev
ENV NODE_ENV=development
COPY web web
CMD ["npm", "run", "dev", "--workspace", "@console/web", "--", "--host", "0.0.0.0"]

FROM deps AS build
COPY web web
RUN npm run build --workspace @console/web

# The output is static files only. Caddy serves them; there is no Node process.
FROM alpine:3 AS dist
WORKDIR /dist
COPY --from=build /app/web/dist ./
