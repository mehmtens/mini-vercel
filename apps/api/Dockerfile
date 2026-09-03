FROM node:22-alpine AS base
RUN apk add --no-cache openssl libc6-compat
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /app

# Copy root workspace and package manifests
COPY --chown=node:node pnpm-lock.yaml* pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node apps/api/ ./apps/api/

RUN pnpm install --filter @doplo/api...
RUN pnpm --filter @doplo/database generate
RUN pnpm --filter "@doplo/api^..." build
RUN pnpm --filter @doplo/api build

# Security: Run application as unprivileged non-root user
USER node
WORKDIR /app/apps/api

EXPOSE 8080
CMD ["node", "dist/index.js"]
