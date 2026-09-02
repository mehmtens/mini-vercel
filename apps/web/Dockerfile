FROM node:22-alpine AS base
RUN apk add --no-cache openssl libc6-compat
ARG NEXT_PUBLIC_API_URL=http://localhost:8081
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_BASE_DOMAIN=localhost
ENV NEXT_PUBLIC_BASE_DOMAIN=$NEXT_PUBLIC_BASE_DOMAIN
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /app

# Copy workspace configuration
COPY --chown=node:node pnpm-lock.yaml* pnpm-workspace.yaml package.json turbo.json tsconfig.json ./
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node apps/web/ ./apps/web/

RUN pnpm install --filter @mini-vercel/web...
RUN pnpm --filter "@mini-vercel/web^..." build
RUN pnpm --filter @mini-vercel/web build

# Security: Run application as unprivileged non-root user
USER node
WORKDIR /app/apps/web

EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
