FROM node:24.11.0-bookworm-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# Every workspace named in the root package.json must have its manifest present
# or npm ci fails, even for workspaces this image does not install.
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
COPY web/package.json web/
# devDependencies are needed here: TypeScript compiles both workspaces below.
RUN npm ci --include=dev --workspace @console/shared --workspace @console/api --include-workspace-root

# Development: tsx watches the source, which compose bind-mounts over api/src.
# node_modules stays baked into the image and is shadowed by an anonymous volume
# in compose, so the container's Linux builds of argon2 and esbuild win over the
# host's win32 ones. The command comes from compose - server or worker.
FROM deps AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
RUN npm run build --workspace @console/shared
COPY api api

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
RUN npm run build --workspace @console/shared
COPY api api
# Compiled rather than run through Node's type stripping: the source imports
# siblings with .js specifiers, which Node does not remap to .ts.
RUN npx tsc -p api/tsconfig.build.json

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/api/package.json api/
COPY --from=build /app/web/package.json web/
RUN npm ci --omit=dev --workspace @console/shared --workspace @console/api --include-workspace-root
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/api/dist api/dist
CMD ["node", "api/dist/server.js"]
