# Development Dockerfile for Familiarise
FROM node:22-alpine

# Install dependencies for native modules (bcrypt, sharp)
RUN apk add --no-cache libc6-compat python3 make g++

WORKDIR /app

# Copy package files. `.npmrc` MUST come along so the image resolves
# dependencies exactly as local and CI do. It no longer sets
# `legacy-peer-deps` — the one real conflict (better-call's peerOptional
# zod@^4 against the project's zod@3) is pinned by `overrides` in
# package.json, so a genuinely bad conflict elsewhere still fails loudly.
COPY package.json package-lock.json .npmrc ./

# Prisma schema must land BEFORE the install: package.json has a `postinstall`
# of `prisma generate`, which fails with "Could not find Prisma Schema" if the
# schema arrives afterwards.
COPY prisma ./prisma/

# `--ignore-scripts` (sonar docker:S6505): a plain `npm ci` executes the
# lifecycle scripts of every transitive dependency, which is arbitrary code
# from the registry running in the build. We want exactly one of those scripts
# — our own `prisma generate` — so it is suppressed for everything and then run
# explicitly. The local binary rather than `npx`, which would be allowed to
# fetch and execute an unpinned package on demand (docker:S6505, docker:S8543).
RUN npm ci --ignore-scripts && ./node_modules/.bin/prisma generate

# Copy application files (volumes will override in dev)
COPY . .

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start development server
CMD ["npm", "run", "dev"]
