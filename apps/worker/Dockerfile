FROM node:22-alpine AS base
RUN apk add --no-cache openssl libc6-compat
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /app

# Copy workspace configuration
COPY --chown=node:node pnpm-lock.yaml* pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node apps/worker/ ./apps/worker/

RUN pnpm install --filter @mini-vercel/worker...
RUN pnpm --filter @mini-vercel/database generate
RUN pnpm --filter "@mini-vercel/worker^..." build
RUN pnpm --filter @mini-vercel/worker build

# Security: Run application as unprivileged non-root user
USER node
WORKDIR /app/apps/worker

CMD ["node", "dist/index.js"]
