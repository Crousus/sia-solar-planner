# Build context must be the repo root (not ./pdf-service) so we can copy
# shared source files from src/pdf/ and src/types/.
# docker-compose sets `context: .` for this service.

FROM node:22-alpine

WORKDIR /app

# Install dependencies first (separate layer for cache efficiency).
COPY pdf-service/package.json ./
RUN npm install

# Copy the service entrypoint.
COPY pdf-service/server.ts ./pdf-service/server.ts

# Copy the shared source files the service imports.
# SolarPlanDoc.tsx only does `import type` from composeStageImage.ts, so
# that file is not needed at runtime — tsx strips type imports before
# execution, meaning html2canvas / konva are never loaded here.
COPY src/pdf/SolarPlanDoc.tsx ./src/pdf/SolarPlanDoc.tsx
COPY src/types/index.ts ./src/types/index.ts

CMD ["npx", "tsx", "pdf-service/server.ts"]
