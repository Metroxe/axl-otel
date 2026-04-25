# syntax=docker/dockerfile:1.7

FROM golang:1.25 AS axl-builder
WORKDIR /src
ARG AXL_REF=main
RUN git clone --depth 1 --branch "${AXL_REF}" https://github.com/gensyn-ai/axl.git . \
 && go build -o /out/axl-node ./cmd/node/

FROM oven/bun:1.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=axl-builder /out/axl-node /usr/local/bin/axl-node

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV AXL_URL=http://127.0.0.1:9002 \
    AXL_CONFIG=/etc/axl/node-config.json \
    PORT=8080

EXPOSE 8080 9001 9002

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
