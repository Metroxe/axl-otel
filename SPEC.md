# AXL OTel sidecar — specification

**This was generated as a part of this claude session https://claude.ai/share/031c83be-eeeb-40ad-96a8-941c2f0b5640**

A drop-in OTLP sidecar that gives AXL agent meshes peer-to-peer distributed tracing. The originator of a workflow automatically receives every span from every agent it called, with no central collector and no preconfigured peer identities.

## About AXL

[AXL (Agent eXchange Layer)](https://docs.gensyn.ai/tech/agent-exchange-layer) is a peer-to-peer network node built by [Gensyn](https://www.gensyn.ai/). It provides an encrypted, decentralized communication layer for applications, allowing AI agents and ML pipelines to exchange data directly between machines without a central server.

AXL runs as a single binary on each participating machine. It connects to the [Yggdrasil](https://yggdrasil-network.github.io/) mesh network underneath and exposes a local HTTP API on `localhost:9002`. Applications send and receive bytes by addressing peers by their ed25519 public key. AXL handles encryption, routing, and peer discovery. It runs entirely in userspace via gVisor's network stack, requires no root or TUN device, and works behind NAT without port forwarding.

AXL ships with built-in support for [MCP](https://modelcontextprotocol.io/) and [A2A](https://github.com/google/A2A) for structured agent-to-agent communication. The relevant endpoints used by this project:

- `GET /topology` — returns this node's peer ID and known peers.
- `POST /send` — fire-and-forget message to a peer addressed by `X-Destination-Peer-Id`.
- `GET /recv` — poll for inbound messages addressed to this node that didn't match MCP or A2A envelopes.
- `POST /mcp/{peer_id}/{service}` — call an MCP service on a remote peer.
- `POST /a2a/{peer_id}` — call an A2A endpoint on a remote peer.

Documentation: <https://docs.gensyn.ai/tech/agent-exchange-layer>. Source: <https://github.com/gensyn-ai/axl>.

## What this project is

A single sidecar process that runs alongside an AXL node on each machine. Agents emit OpenTelemetry spans to the sidecar over standard OTLP. The sidecar routes spans to the workflow's originator via AXL's `/send` endpoint. The originator's sidecar receives inbound spans via AXL's `/recv` endpoint and forwards them to a local Jaeger instance for visualization.

## Architecture

### Components

**Sidecar** (`axl-otel`). One binary, two roles controlled by flags:

- Default mode: listens on `localhost:4318` for OTLP HTTP, routes spans based on the originator peer ID embedded in each span's context.
- `--receive` mode (additionally enabled on the originator's machine): polls AXL's `/recv` endpoint for inbound span messages and forwards them to a local Jaeger via OTLP.

**AXL node.** Unmodified. The sidecar is a normal HTTP client of AXL's existing API at `localhost:9002`.

**Jaeger.** Off-the-shelf `jaegertracing/all-in-one` Docker image. Provides storage, query, and UI. Listens for OTLP on `:4318`, serves UI on `:16686`. Only required on the originator's machine.

**Agent code.** Uses any standard OpenTelemetry SDK with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. No custom code or libraries from this project.

### Span flow

Forward (work):
```
Originator agent sets baggage entry "originator_peer_id" at workflow start
  → makes calls (MCP, A2A, HTTP, anything) to other peers
  → standard OTel propagators carry baggage across each call boundary
  → downstream peers receive baggage as part of their OTel context
```

Backward (telemetry):
```
Each agent emits OTel spans to localhost:4318
  → BaggageSpanProcessor stamps baggage entries onto spans as attributes
  → sidecar reads "originator_peer_id" attribute on each span
  → if originator == this peer: forward to local Jaeger via OTLP
  → otherwise: AXL /send to originator's peer ID
On the originator's machine, sidecar in --receive mode polls /recv
  → each inbound span message → forward to local Jaeger via OTLP
```

### Originator propagation

The originator's peer ID rides in standard OpenTelemetry baggage. Baggage is OTel's official mechanism for propagating user-defined key-value pairs alongside trace context, available in every major-language SDK and standardized by the W3C.

How it works end-to-end:

1. The originator sets a baggage entry `originator_peer_id = <own peer ID>` at the start of a workflow.
2. Whatever instrumentation the agent uses for outbound calls (MCP, A2A, HTTP, gRPC, etc.) injects baggage into the call alongside trace context. The OTel MCP semantic conventions specify that baggage rides in `params._meta` as a standard W3C `baggage` header value.
3. Downstream peers extract baggage on inbound calls (also handled by the same instrumentation).
4. Every span emitted under that context inherits baggage via the standard `BaggageSpanProcessor`, which copies entries onto spans as attributes.
5. The sidecar reads the `originator_peer_id` attribute and routes the span accordingly.

This project does not ship protocol-specific instrumentation. The agent author uses whatever OTel instrumentation is appropriate for their call protocol. As long as baggage propagates through the call chain and `BaggageSpanProcessor` is registered, the sidecar gets what it needs.

### Routing rule

For each span the sidecar receives via OTLP:

- If the `originator_peer_id` attribute equals this peer's ID or is unset: forward to local Jaeger.
- Otherwise: send to the value of `originator_peer_id` via AXL `/send`.

The originator's sidecar receives both its own local spans and inbound spans from all participants, all of which land in the same local Jaeger.

## API contracts

### Sidecar inputs

- **OTLP HTTP** on `localhost:4318/v1/traces` — accepts standard OTLP JSON.
- **AXL `/recv`** polled (only in `--receive` mode) — span messages arriving from remote peers.

### Sidecar outputs

- **AXL `/send`** with `X-Destination-Peer-Id` header — for spans destined for a remote originator.
- **Local Jaeger OTLP HTTP** on `localhost:4318/v1/traces` (different host, same port) — for local-originator spans.

Note: Jaeger and the sidecar both default to port 4318. Inside Docker they live in separate containers so the conflict is moot. For native installs, configure one of them to a different port.

### Context propagation requirements

This project does not define a wire protocol. It depends on standard OpenTelemetry primitives being correctly configured by the adopter:

1. **Baggage entry.** The originator sets `originator_peer_id` as an OTel baggage entry, with its value being its own AXL ed25519 peer ID (64-character hex).
2. **Baggage propagation.** The OTel global propagator includes `W3CBaggagePropagator` (the default in every major OTel SDK). Baggage flows across call boundaries via whatever transport the agent uses, carried by standard or third-party instrumentation libraries.
3. **Span stamping.** Every agent registers `BaggageSpanProcessor` (a standard, optional OTel component). This copies baggage entries onto every span as attributes at span-start, making them visible to the sidecar via OTLP.
4. **OTLP endpoint.** Every agent sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` so spans flow to the local sidecar.

For agents using MCP, the OTel MCP semantic conventions specify that trace context and baggage are carried in `params._meta` as standard W3C-formatted strings. Mature MCP instrumentation libraries handle this automatically. The same pattern applies to A2A and any other transport — protocol-specific instrumentation is the OTel ecosystem's responsibility, not this project's.

## Repository layout

```
axl-otel/
├── README.md
├── SPEC.md                  ← this file
├── sidecar/                 ← the main library/binary
│   ├── Dockerfile
│   ├── package.json
│   └── src/
├── example/                 ← reproducible 5-agent demo
│   ├── README.md
│   ├── docker-compose.yml
│   ├── scripts/
│   │   ├── generate-keys.sh ← generates ed25519 keys per agent
│   │   └── setup.sh         ← generates keys + AXL configs
│   ├── keys/                ← gitignored
│   ├── configs/             ← gitignored, generated
│   └── agents/
│       ├── editor/
│       │   ├── Dockerfile
│       │   ├── public/      ← static HTML frontend served by Editor
│       │   └── src/
│       ├── researcher/
│       ├── web-search/
│       ├── fact-checker/
│       └── citation-db/
└── hello-world/             ← minimal integration example
    ├── README.md
    └── index.ts
```

## Example workflow

The `example/` directory contains a reproducible 5-agent workflow:

| Agent | Role |
|---|---|
| Editor | Originator. Orchestrates the workflow using Claude Sonnet 4.6 via the Anthropic API. Serves the HTML frontend. |
| Researcher | MCP server. Calls Web-Search, synthesizes results. |
| Web-Search | MCP server with hardcoded responses. |
| Fact-Checker | MCP server. Calls Citation-DB to verify sources. |
| Citation-DB | MCP server with a hardcoded reputability table. |

Call pattern: `Editor → Researcher → Web-Search` and `Editor → Fact-Checker → Citation-DB`.

### Container model

Each agent runs in its own Docker container. Each container runs four processes via a small entrypoint script:

1. AXL node (Gensyn's binary, built from source in a multi-stage Dockerfile)
2. AXL's MCP router (Python sidecar that ships with AXL)
3. The OTel sidecar (this project)
4. The agent's own code

The Editor container additionally serves the static HTML frontend on port 8080 and runs the sidecar in `--receive` mode.

A separate Jaeger container runs `jaegertracing/all-in-one`, exposing the UI on `localhost:16686`.

### Networking

Docker bridge network. Each container has its own loopback. AXL nodes peer through the bridge network using one designated bootstrap container; the rest reference it as a peer. Only Jaeger's UI port and the Editor's frontend port are exposed to the host.

### Keys and configs

`scripts/generate-keys.sh` generates one ed25519 keypair per agent and writes them to `keys/`, which is gitignored. `scripts/setup.sh` runs the key generation and additionally generates AXL `node-config.json` files for each agent with the right peer references baked in.

Quickstart: `./scripts/setup.sh && docker compose up`.

### Frontend

The Editor serves a static HTML page on `localhost:8080` containing:

- A textarea for the prompt.
- A submit button that POSTs to the Editor's `/run` endpoint.
- A live mesh activity panel that subscribes to the Editor's `GET /events` SSE stream. The Editor publishes each tool call (start, end, status, latency) to this stream as it happens, derived from the same OTel spans that flow to the sidecar.
- A result display that shows the final composed output.

Vanilla HTML/CSS/JS, no framework, no build step. Served as static files from the Editor's process. Same origin as the API so no CORS handling is needed.

## Trust model

- AXL handles transport-layer authentication via ed25519 keys. Every message arriving at AXL is cryptographically associated with its sender.
- The `originator_peer_id` baggage entry is self-reported and not signed. Baggage rides in plaintext through every peer in the call chain, and any peer can read or rewrite it. The blast radius of tampering is bounded: the originator simply doesn't receive spans whose originator entry was rewritten, and a bad peer cannot impersonate a different sender at the network layer.
- Span content itself is not signed. The originator trusts its participants to report truthfully.
- Production deployments would sign the originator claim and individual spans. This is documented as future work and out of scope for v1.

## Out of scope

- Custom Jaeger UI replacement.
- Custom tracing format. OpenTelemetry only.
- Persistent trace storage outside Jaeger.
- Span signing or capability tokens.
- Subscriber / broadcast model. Originator-only delivery is the supported design.
- Modifications to the AXL node or its packaged sidecars.
- Bundling AXL into a derived binary or container.
- Metrics or logs. Traces only in v1.
- Protocol-specific instrumentation (MCP, A2A, custom). Adopters use standard or third-party OTel instrumentation appropriate to their transport. This project consumes the resulting spans.
- A custom client library or wrapper that agents must import. Integration is via standard OTel configuration.

## Future work

- Retry and buffering for `/send` failures with exponential backoff.
- Deduplication at the originator for retried spans (monotonic send counter or content hash).
- Span signing for tamper-evidence.
- Subscriber-style opt-in for third-party observers.
- Backpressure handling when the originator can't keep up.
- Metrics and logs in addition to traces.

## Day-one verification checklist

Before building, verify these three things in order:

1. AXL builds and runs. Two nodes peered locally. `/topology` shows them seeing each other. One MCP call between them succeeds.
2. OTel baggage propagates through the agent's chosen call protocol. With `W3CBaggagePropagator` registered and a baggage entry set on the originator, an inbound handler on a remote peer sees the same entry in its OTel context. For MCP, this means verifying the chosen MCP instrumentation library actually injects baggage into `params._meta` as the OTel MCP semantic conventions specify — not all libraries are equally mature on this. This is the load-bearing assumption of the design; if it doesn't work end-to-end, baggage must be injected manually into `_meta` until upstream catches up.
3. Jaeger all-in-one accepts an OTLP span via curl and renders it in the UI.

If any of these fail, the rest of the build cannot proceed without adjustment.

## Versioning constraints

- AXL's HTTP API at `localhost:9002`: depends on the surface defined in AXL's `docs/api.md` as of the AXL repo at the time of writing. Specifically `/topology`, `/send`, `/recv`, `/mcp/{peer}/{service}`, `/a2a/{peer}`.
- OpenTelemetry: SDKs and OTLP HTTP per spec. Tested against `@opentelemetry/sdk-trace-node` 1.x.
- Jaeger: tested against `jaegertracing/all-in-one:latest`.
- Anthropic SDK: tested against `@anthropic-ai/sdk` with `claude-sonnet-4-6`.

## References

- AXL documentation: <https://docs.gensyn.ai/tech/agent-exchange-layer>
- AXL source: <https://github.com/gensyn-ai/axl>
- AXL HTTP API reference: <https://github.com/gensyn-ai/axl/blob/main/docs/api.md>
- AXL architecture: <https://github.com/gensyn-ai/axl/blob/main/docs/architecture.md>
- AXL integrations (MCP router, A2A server): <https://github.com/gensyn-ai/axl/blob/main/docs/integrations.md>
- Gensyn: <https://www.gensyn.ai/>
- OpenTelemetry: <https://opentelemetry.io/>
- OpenTelemetry Protocol (OTLP): <https://opentelemetry.io/docs/specs/otlp/>
- OpenTelemetry baggage: <https://opentelemetry.io/docs/concepts/signals/baggage/>
- OpenTelemetry MCP semantic conventions: <https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/>
- W3C Trace Context: <https://www.w3.org/TR/trace-context/>
- W3C Baggage: <https://www.w3.org/TR/baggage/>
- Jaeger: <https://www.jaegertracing.io/>
- Model Context Protocol (MCP): <https://modelcontextprotocol.io/>
- Agent2Agent (A2A): <https://github.com/google/A2A>
- Yggdrasil network: <https://yggdrasil-network.github.io/>