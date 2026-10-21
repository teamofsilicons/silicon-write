# The Silicon Write service (write-api) with the converters it runs: Pandoc, LibreOffice (Writer, headless) and
# pdftotext. Build from the repository root:  docker build -f deploy/Dockerfile -t silicon-write-api .
FROM rust:1.98-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
RUN cargo build --release -p write-api

FROM debian:bookworm-slim
ARG PANDOC_VERSION=3.12.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libreoffice-writer-nogui poppler-utils ffmpeg fonts-dejavu-core \
 && curl -fsSL -o /tmp/pandoc.deb "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-$(dpkg --print-architecture).deb" \
 && apt-get install -y /tmp/pandoc.deb && rm /tmp/pandoc.deb \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home /var/lib/write --create-home write
COPY --from=build /src/target/release/write-api /usr/local/bin/write-api
USER write
ENV WRITE_BIND=0.0.0.0:4371 WRITE_DATA_DIR=/var/lib/write/data WRITE_SOFFICE=soffice WRITE_ENVIRONMENT=production
VOLUME /var/lib/write/data
EXPOSE 4371
HEALTHCHECK CMD ["/bin/sh", "-c", "exec 3<>/dev/tcp/127.0.0.1/4371 && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q ok <&3"]
ENTRYPOINT ["/usr/local/bin/write-api"]
