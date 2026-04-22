# Stage 1: build the Go binary.
# We use the full golang image (not alpine) to avoid CGo edge cases with
# the goja JS engine that PocketBase embeds for jsvm migrations.
FROM golang:1.24 AS builder
WORKDIR /build

# Download dependencies first so this layer caches across source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o pocketbase .

# Stage 2: minimal runtime image.
FROM alpine:3.20
# ca-certificates: PocketBase makes HTTPS calls (OAuth providers, S3 backups).
# tzdata: timezone-aware timestamps in hooks / cron.
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /build/pocketbase ./

# JS migrations are loaded at startup from <data-dir>/../pb_migrations, i.e.
# /app/pb_migrations when --dir=/app/pb_data.  Copy them in so the image
# is self-contained; the dev compose overrides this with a bind-mount.
COPY pb_migrations ./pb_migrations

# pb_data contains the SQLite file and uploaded files.  It must be a volume
# (named in docker-compose.yml) so data survives image rebuilds.
VOLUME ["/app/pb_data"]

EXPOSE 8090

# 0.0.0.0 so Docker can reach the port from outside the container.
CMD ["./pocketbase", "serve", "--http=0.0.0.0:8090", "--dir=/app/pb_data"]
