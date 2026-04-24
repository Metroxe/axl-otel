# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun build --compile --minify --sourcemap src/index.ts --outfile /app/axl-otel

FROM gcr.io/distroless/cc-debian12
COPY --from=builder /app/axl-otel /usr/local/bin/axl-otel
EXPOSE 4318
ENTRYPOINT ["/usr/local/bin/axl-otel"]
