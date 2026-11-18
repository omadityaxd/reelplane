# Reelplane transcoding worker: one image for a laptop, a VM or a container host.
#   docker build -t reelplane-worker services/worker
#   Production: `pnpm prod:worker` (scripts/run-worker.ts) runs it locked down.
# Base images are pinned by digest (Dependabot updates them). FFmpeg comes from Debian at build
# time; FFMPEG_REFRESH (prod:worker passes the ISO week) re-runs that layer weekly for security
# updates.

FROM golang:1.27.4-trixie@sha256:f18c3d73a184fb0582828510722e723b63a93f7188d11dd223d9be6f6880e65d AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static binary: the runtime image needs nothing but FFmpeg.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
ARG FFMPEG_REFRESH=unset
RUN echo "packages as of ${FFMPEG_REFRESH}" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin worker
COPY --from=build /out/worker /usr/local/bin/worker
USER worker
ENV LOG_FORMAT=json \
    WORKER_TEMP_DIR=/tmp
# The worker drains in-flight work on SIGTERM; give `docker stop` longer than its grace period.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/worker"]
