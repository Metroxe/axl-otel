import { initOtel } from "./otel.ts";
import { startMcpServer, type ToolDef } from "./mcp-server.ts";
import { callMcp, readPeerId } from "./mcp-client.ts";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "researcher";
const AXL_URL = process.env.AXL_URL ?? "http://127.0.0.1:9002";
const ROUTER_URL = process.env.MCP_ROUTER_URL ?? "http://127.0.0.1:9003";
const MCP_PORT = Number(process.env.MCP_LISTEN_PORT ?? 7100);

type SearchResult = { title: string; url: string; snippet: string };
type SearchResponse = { query: string; results: SearchResult[] };

function summarise(topic: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No sources found for "${topic}".`;
  }
  const bullets = results
    .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`)
    .join("\n");
  return `Found ${results.length} source${results.length === 1 ? "" : "s"} on "${topic}":\n${bullets}`;
}

const tracer = initOtel(SERVICE_NAME);

const tools: ToolDef[] = [
  {
    name: "research",
    description:
      "Research a topic by querying the upstream Web-Search agent and synthesising the top results into a short summary plus a list of sources.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "topic to research" },
        depth: {
          type: "integer",
          description: "max sources to consult (default 3)",
        },
      },
      required: ["topic"],
    },
    async handler(args) {
      const topic = String(args.topic ?? "");
      const depth = Math.min(
        Math.max(1, Number(args.depth ?? 3) || 3),
        6,
      );
      const webSearchPeer = readPeerId("web-search");
      const search = await callMcp<SearchResponse>({
        axlUrl: AXL_URL,
        peerId: webSearchPeer,
        service: "web-search",
        tool: "search",
        args: { query: topic, limit: depth },
        tracer,
      });
      return {
        topic,
        summary: summarise(topic, search.results),
        sources: search.results,
      };
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

const peerId = await waitForAxl();
console.log(`${SERVICE_NAME}: AXL ready  peer=${peerId.slice(0, 12)}…`);
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
