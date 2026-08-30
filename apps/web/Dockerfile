FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy workspace configuration
COPY --chown=node:node pnpm-lock.yaml* pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node apps/web/ ./apps/web/

RUN pnpm install --filter @mini-vercel/web...
RUN pnpm --filter @mini-vercel/web build

RUN chown -R node:node /app

# Security: Run application as unprivileged non-root user
USER node

EXPOSE 3000
CMD ["pnpm", "--filter", "@mini-vercel/web", "start"]
