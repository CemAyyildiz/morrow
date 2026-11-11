# The hosted web app (story 10.3): the production build of apps/web, served by
# apps/web/server/serve.ts, which needs only Node built-ins at runtime.
# Build from the repository root: docker build -f infra/web/Dockerfile .

FROM node:24.22.2-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core-ts/package.json packages/core-ts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @morrow/web...
COPY packages/core-ts packages/core-ts
COPY apps/web apps/web
RUN pnpm --filter @morrow/web build

FROM node:24.22.2-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/web/server server
COPY --from=build /repo/apps/web/dist dist
COPY --from=build /repo/apps/web/package.json package.json
USER node
EXPOSE 8080
CMD ["node", "server/serve.ts"]
