# Reelplane transcoding worker: one image for a laptop, a VM or a container host.
#   docker build -t reelplane-worker services/worker
#   docker run --env-file .env reelplane-worker

FROM golang:1.27-trixie AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static binary: the runtime image needs nothing but FFmpeg.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker

FROM debian:trixie-slim
RUN apt-get update \
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
