# Stage 1: build the Go binary.
# We use the full golang image (not alpine) to avoid CGo edge cases with
# the goja JS engine that PocketBase embeds for jsvm migrations.
#
# Go version: PocketBase v0.40 requires Go >= 1.27 (it migrated to
# encoding/json/v2) and recommends 1.27.1+ for database/sql + json fixes.
# Keep this in sync with the `go` directive in go.mod.
FROM golang:1.27 AS builder
WORKDIR /build

# Download dependencies first so this layer caches across source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o pocketbase .

# Stage 2: minimal runtime image.
FROM alpine:3.20
# ca-certificates: PocketBase makes HTTPS calls (OAuth providers, S3 backups).
# tzdata: timezone-aware timestamps in hooks / cron.
RUN apk add --no-cache ca-certificates tzdata

# Run as an unprivileged user (audit finding: container ran as root, so any
# RCE in PocketBase/goja would own the container and every mounted volume).
# Fixed numeric uid/gid so volume ownership is predictable across rebuilds.
RUN addgroup -S -g 10001 pocketbase \
 && adduser -S -D -H -u 10001 -G pocketbase -s /sbin/nologin pocketbase

WORKDIR /app
COPY --from=builder /build/pocketbase ./

# JS migrations are loaded at startup from <data-dir>/../pb_migrations, i.e.
# /app/pb_migrations when --dir=/app/pb_data.  Copy them in so the image
# is self-contained; the dev compose overrides this with a bind-mount.
# Binary + migrations stay root-owned (read-only for the runtime user).
COPY pb_migrations ./pb_migrations

# pb_data contains the SQLite file and uploaded files.  It must be a volume
# (named in docker-compose.yml) so data survives image rebuilds.
#
# The directory is created and chowned BEFORE the VOLUME instruction so a
# fresh named volume is initialised with pocketbase:pocketbase ownership.
# EXISTING volumes created by the old root-running image keep root-owned
# files; fix them once with:
#   docker compose run --rm --user root backend chown -R 10001:10001 /app/pb_data
# (see server/README.md → "Upgrading an existing deployment").
RUN mkdir -p /app/pb_data && chown -R pocketbase:pocketbase /app/pb_data
VOLUME ["/app/pb_data"]

USER pocketbase:pocketbase

EXPOSE 8090

# 0.0.0.0 so Docker can reach the port from outside the container.
CMD ["./pocketbase", "serve", "--http=0.0.0.0:8090", "--dir=/app/pb_data"]
