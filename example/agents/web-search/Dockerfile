# syntax=docker/dockerfile:1.7

FROM golang:1.25 AS axl-builder
WORKDIR /src
ARG AXL_REF=main
RUN git clone --depth 1 --branch "${AXL_REF}" https://github.com/gensyn-ai/axl.git . \
 && go build -o /out/axl-node ./cmd/node/

FROM oven/bun:1.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini python3 python3-venv python3-pip git \
 && rm -rf /var/lib/apt/lists/*

# AXL Python integrations (MCP router on :9003).
ARG AXL_REF=main
RUN git clone --depth 1 --branch "${AXL_REF}" https://github.com/gensyn-ai/axl.git /opt/axl-src \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -e /opt/axl-src/integrations
ENV PATH=/opt/venv/bin:$PATH

COPY --from=axl-builder /out/axl-node /usr/local/bin/axl-node

# OTel sidecar (this project) — runs in default mode here.
WORKDIR /sidecar
COPY sidecar/package.json sidecar/bun.lock ./
RUN bun install --frozen-lockfile
COPY sidecar/src ./src
RUN bun build --compile --minify --target=bun-linux-x64-baseline \
      src/index.ts --outfile sidecar

# Agent code.
WORKDIR /app
COPY example/agents/web-search/package.json ./
RUN bun install
COPY example/agents/web-search/src ./src
RUN bun build --compile --minify --target=bun-linux-x64-baseline \
      src/index.ts --outfile agent
COPY example/agents/web-search/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV AXL_URL=http://127.0.0.1:9002 \
    AXL_CONFIG=/etc/axl/node-config.json \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
    MCP_ROUTER_URL=http://127.0.0.1:9003 \
    MCP_LISTEN_PORT=7100

EXPOSE 9001 9002 9003 4318 7100
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
