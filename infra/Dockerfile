# One image for all Node services; the service is chosen by the command.
# NOTE: worker-browser will move to a Playwright base image (Chromium + Xvfb + noVNC) when the
# fb-web connector lands (build plan phase 2–5).
FROM node:20.19-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && DATABASE_URL=postgresql://build@localhost/build pnpm db:generate

ENV NODE_ENV=production
USER node
# e.g. command: ["node", "--import", "tsx", "apps/worker-core/src/main.ts"]
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
