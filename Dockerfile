# One image for every role (ADR-0002). Select roles with ROLE=api,worker,scheduler (default: all).
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production COREPACK_HOME=/corepack
WORKDIR /app
# pnpm (the version pinned in package.json) is part of the image, so a container never downloads it.
COPY package.json ./
RUN corepack enable && corepack install && chmod -R a+rX /corepack

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/server ./apps/server
# Only the server and the packages it uses (spikes and the Phase −1 demo stay out of the image).
RUN pnpm install --frozen-lockfile --filter "@agentic-marketing/server..."

# The live admin UI: a production build of `apps/web` in `live` mode (no demo screens).
FROM base AS web
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
# The build tooling (Vite, TypeScript) is a dev dependency, and base sets NODE_ENV=production.
RUN pnpm install --frozen-lockfile --prod=false --filter "@agentic-marketing/web..."
RUN pnpm --filter @agentic-marketing/web build:live

FROM base
# The commit this image was built from, reported as `commit` by /healthz and /readyz.
ARG GIT_SHA
ENV AM_GIT_SHA=$GIT_SHA
COPY --from=deps /app /app
COPY --from=web /app/apps/web/dist /app/apps/web/dist
# `am` is the admin CLI without pnpm's script banner (which would echo arguments such as secrets).
RUN printf '#!/bin/sh\nexec pnpm --silent --filter @agentic-marketing/server cli "$@"\n' > /usr/local/bin/am && chmod +x /usr/local/bin/am
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:3000/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["pnpm", "--filter", "@agentic-marketing/server", "start"]
