import { initOtel } from "./otel.ts";
import { startMcpServer, type ToolDef } from "./mcp-server.ts";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "web-search";
const AXL_URL = process.env.AXL_URL ?? "http://127.0.0.1:9002";
const ROUTER_URL = process.env.MCP_ROUTER_URL ?? "http://127.0.0.1:9003";
const MCP_PORT = Number(process.env.MCP_LISTEN_PORT ?? 7100);
// Simulated work latency so the search span shows up as a visible bar in
// Jaeger rather than a hairline. The hardcoded fixture lookup is otherwise
// instantaneous, which makes the trace look broken to a viewer.
const SEARCH_LATENCY_MS = Number(process.env.SEARCH_LATENCY_MS ?? 450);

// Hardcoded result set per SPEC. Tiny relevance scoring by substring match
// so different queries produce different orderings; everything else is fixed.
const FIXTURES: Array<{
  title: string;
  url: string;
  snippet: string;
  keywords: string[];
}> = [
  {
    title: "Yggdrasil Network — Overview",
    url: "https://yggdrasil-network.github.io/",
    snippet:
      "Yggdrasil is an end-to-end encrypted IPv6 mesh network that routes by public-key.",
    keywords: ["yggdrasil", "mesh", "ipv6", "p2p", "encrypted"],
  },
  {
    title: "OpenTelemetry — Distributed tracing concepts",
    url: "https://opentelemetry.io/docs/concepts/",
    snippet:
      "Spans, traces, and context propagation for cross-service observability.",
    keywords: ["opentelemetry", "tracing", "spans", "observability"],
  },
  {
    title: "W3C Baggage specification",
    url: "https://www.w3.org/TR/baggage/",
    snippet:
      "Standard format for propagating user-defined key/value pairs across services.",
    keywords: ["baggage", "w3c", "propagation", "context"],
  },
  {
    title: "Gensyn AXL documentation",
    url: "https://docs.gensyn.ai/tech/agent-exchange-layer",
    snippet:
      "Peer-to-peer agent communication built on Yggdrasil with MCP and A2A support.",
    keywords: ["axl", "gensyn", "agent", "mcp", "p2p"],
  },
  {
    title: "Model Context Protocol",
    url: "https://modelcontextprotocol.io/",
    snippet: "Open protocol for connecting LLM agents to tools and data sources.",
    keywords: ["mcp", "llm", "agents", "tools"],
  },
  {
    title: "Jaeger Tracing — All-in-one quickstart",
    url: "https://www.jaegertracing.io/docs/getting-started/",
    snippet: "Run Jaeger locally with the all-in-one image to visualise traces.",
    keywords: ["jaeger", "tracing", "ui", "otlp"],
  },
];

function score(query: string, kws: string[]): number {
  const q = query.toLowerCase();
  let s = 0;
  for (const k of kws) if (q.includes(k)) s += 1;
  // Boost very short queries by giving every fixture a base score so calls
  // with niche terms still return a stable list.
  return s + 0.001;
}

const tools: ToolDef[] = [
  {
    name: "search",
    description:
      "Search the web for results matching a free-text query. Returns a fixed corpus ranked by keyword overlap; suitable for offline demos.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "free-text search query" },
        limit: {
          type: "integer",
          description: "max results to return (default 3)",
        },
      },
      required: ["query"],
    },
    async handler(args) {
      const query = String(args.query ?? "");
      const limit = Math.min(
        Math.max(1, Number(args.limit ?? 3) || 3),
        FIXTURES.length,
      );
      if (SEARCH_LATENCY_MS > 0) {
        await new Promise((r) => setTimeout(r, SEARCH_LATENCY_MS));
      }
      const ranked = FIXTURES.map((r) => ({ r, s: score(query, r.keywords) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(({ r }) => ({ title: r.title, url: r.url, snippet: r.snippet }));
      return { query, results: ranked };
    },
  },
];

async function registerWithRouter(retries = 60): Promise<void> {
  const endpoint = `http://127.0.0.1:${MCP_PORT}/mcp`;
  const body = JSON.stringify({ service: SERVICE_NAME, endpoint });
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${ROUTER_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.ok) {
        console.log(
          `router: registered ${SERVICE_NAME} -> ${endpoint} at ${ROUTER_URL}`,
        );
        return;
      }
      lastErr = new Error(`${res.status} ${await res.text()}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `failed to register with router at ${ROUTER_URL}: ${String(lastErr)}`,
  );
}

async function waitForAxl(timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${AXL_URL}/topology`);
      if (res.ok) {
        const j = (await res.json()) as { our_public_key?: string };
        if (j.our_public_key) return j.our_public_key;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`AXL not ready at ${AXL_URL}: ${String(lastErr)}`);
}

const tracer = initOtel(SERVICE_NAME);
const peerId = await waitForAxl();
console.log(
  `${SERVICE_NAME}: AXL ready  peer=${peerId.slice(0, 12)}…`,
);
startMcpServer({ port: MCP_PORT, serviceName: SERVICE_NAME, tools, tracer });
await registerWithRouter();

async function deregister(): Promise<void> {
  try {
    await fetch(`${ROUTER_URL}/register/${SERVICE_NAME}`, { method: "DELETE" });
  } catch {
    // best effort
  }
}
process.on("SIGINT", () => void deregister().finally(() => process.exit(0)));
process.on("SIGTERM", () => void deregister().finally(() => process.exit(0)));
