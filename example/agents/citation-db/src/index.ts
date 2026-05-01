import { initOtel } from "./otel.ts";
import { startMcpServer, type ToolDef } from "./mcp-server.ts";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "citation-db";
const AXL_URL = process.env.AXL_URL ?? "http://127.0.0.1:9002";
const ROUTER_URL = process.env.MCP_ROUTER_URL ?? "http://127.0.0.1:9003";
const MCP_PORT = Number(process.env.MCP_LISTEN_PORT ?? 7100);

// Hardcoded reputability table per SPEC. Lookups match by hostname; unknown
// hosts return reputability "unknown" rather than an error.
type Reputability = "high" | "medium" | "low" | "unknown";

const TABLE: Record<string, { reputability: Reputability; notes: string }> = {
  "yggdrasil-network.github.io": {
    reputability: "high",
    notes: "Official project documentation; primary source.",
  },
  "opentelemetry.io": {
    reputability: "high",
    notes: "OpenTelemetry project; CNCF-hosted; primary source.",
  },
  "www.w3.org": {
    reputability: "high",
    notes: "W3C standards body; primary source.",
  },
  "docs.gensyn.ai": {
    reputability: "high",
    notes: "Vendor docs for AXL; primary source.",
  },
  "modelcontextprotocol.io": {
    reputability: "high",
    notes: "MCP project site; primary source.",
  },
  "www.jaegertracing.io": {
    reputability: "high",
    notes: "Jaeger project docs; CNCF-hosted; primary source.",
  },
  "github.com": {
    reputability: "medium",
    notes: "Source-code hosting; reputability depends on the repo owner.",
  },
  "en.wikipedia.org": {
    reputability: "medium",
    notes: "User-edited; corroborate with primary sources.",
  },
  "medium.com": {
    reputability: "low",
    notes: "Self-published blog platform; treat as opinion.",
  },
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

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
    async handler(args) {
      const urls = Array.isArray(args.urls) ? (args.urls as string[]) : [];
      const verdicts = urls.map((u) => {
        const host = hostnameOf(u);
        const entry = TABLE[host];
        return {
          url: u,
          domain: host,
          reputability: (entry?.reputability ?? "unknown") as Reputability,
          notes: entry?.notes ?? "Not in the curated reputability table.",
        };
      });
      return { verdicts };
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
