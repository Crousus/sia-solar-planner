# Build context must be the repo root (not ./pdf-service) so we can copy
# shared source files from src/pdf/ and src/types/.
# docker-compose sets `context: .` for this service.

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

# Install dependencies first (separate layer for cache efficiency).
# `npm ci` installs exactly what package-lock.json pins (reproducible,
# audited versions) and fails if package.json and the lockfile disagree —
# `npm install` would silently resolve fresh, unaudited versions.
# --omit=dev: typescript/@types are only needed for `npm run typecheck`;
# tsx (the runtime) is a regular dependency on purpose.
COPY pdf-service/package.json pdf-service/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the service entrypoint and its tsconfig (tsx reads `jsx: react-jsx`
# from it — without it SolarPlanDoc.tsx is compiled with the classic JSX
# transform and fails with "React is not defined").
COPY pdf-service/server.ts pdf-service/tsconfig.json ./pdf-service/

# Copy the shared source files the service imports.
# SolarPlanDoc.tsx only does `import type` from composeStageImage.ts, so
# that file is not needed at runtime — tsx strips type imports before
# execution, meaning html2canvas / konva are never loaded here.
COPY src/pdf/SolarPlanDoc.tsx ./src/pdf/SolarPlanDoc.tsx
COPY src/types/index.ts ./src/types/index.ts

# Drop root. The official node image ships an unprivileged `node` user;
# application files stay root-owned (read-only for the service), so a
# compromised renderer can't rewrite its own code. tsx writes its
# transpile cache under os.tmpdir() (/tmp), which is world-writable.
USER node

EXPOSE 3002

# Invoke the local tsx binary directly rather than `npx`: no registry
# lookup at start-up, and no need for a writable ~/.npm.
CMD ["./node_modules/.bin/tsx", "--tsconfig", "pdf-service/tsconfig.json", "pdf-service/server.ts"]
