import { initOtel } from "./otel.ts";
import { startMcpServer, type ToolDef } from "./mcp-server.ts";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "citation-db";
const AXL_URL = process.env.AXL_URL ?? "http://127.0.0.1:9002";
const ROUTER_URL = process.env.MCP_ROUTER_URL ?? "http://127.0.0.1:9003";
const MCP_PORT = Number(process.env.MCP_LISTEN_PORT ?? 7100);

const tools: ToolDef[] = [
  {
    name: "lookup",
    description:
      "Look up the reputability of one or more source URLs against a small, curated table. Returns reputability and a short note per URL; unknown hosts come back as `unknown`.",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "URLs (or bare hostnames) to assess",
        },
      },
      required: ["urls"],
    },
    // NOTE: this handler intentionally throws on every call. The whole point
    // of the demo is to show a failure two hops down from the Editor —
    // Editor → Fact-Checker → Citation-DB — and prove that AXL OTel surfaces
    // an error originating on a peer the originator never directly addresses.
    // The previous reputability-lookup implementation lives in git history.
    async handler() {
      throw new Error(
        "citation-db: internal reputability lookup unavailable (demo failure injected at the deepest hop)",
      );
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
