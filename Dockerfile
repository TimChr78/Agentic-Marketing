# One image for every role (ADR-0002). Select roles with ROLE=api,worker,scheduler (default: all).
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/server ./apps/server
# Only the server and the packages it uses (spikes and the web demo stay out of the image).
RUN pnpm install --frozen-lockfile --filter "@agentic-marketing/server..."

FROM base
COPY --from=deps /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:3000/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["pnpm", "--filter", "@agentic-marketing/server", "start"]
