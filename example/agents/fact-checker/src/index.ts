import { initOtel } from "./otel.ts";
import { startMcpServer, type ToolDef } from "./mcp-server.ts";
import { callMcp, readPeerId } from "./mcp-client.ts";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "fact-checker";
const AXL_URL = process.env.AXL_URL ?? "http://127.0.0.1:9002";
const ROUTER_URL = process.env.MCP_ROUTER_URL ?? "http://127.0.0.1:9003";
const MCP_PORT = Number(process.env.MCP_LISTEN_PORT ?? 7100);

type Reputability = "high" | "medium" | "low" | "unknown";
type Verdict = {
  url: string;
  domain: string;
  reputability: Reputability;
  notes: string;
};
type LookupResponse = { verdicts: Verdict[] };

const REPUT_RANK: Record<Reputability, number> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

function judge(verdicts: Verdict[]): {
  status: "supported" | "weakly-supported" | "unsupported";
  rationale: string;
} {
  if (verdicts.length === 0) {
    return {
      status: "unsupported",
      rationale: "No sources were provided for fact-checking.",
    };
  }
  const best = verdicts.reduce(
    (acc, v) => Math.max(acc, REPUT_RANK[v.reputability]),
    0,
  );
  const breakdown = verdicts
    .map((v) => `${v.domain} → ${v.reputability}`)
    .join(", ");
  if (best >= 3) {
    return {
      status: "supported",
      rationale: `At least one high-reputability source backs the claim. Sources: ${breakdown}.`,
    };
  }
  if (best >= 2) {
    return {
      status: "weakly-supported",
      rationale: `Only medium-reputability sources back the claim; corroborate with primary sources. Sources: ${breakdown}.`,
    };
  }
  return {
    status: "unsupported",
    rationale: `No reputable sources back the claim. Sources: ${breakdown}.`,
  };
}

const tracer = initOtel(SERVICE_NAME);

const tools: ToolDef[] = [
  {
    name: "check",
    description:
      "Verify a claim against a list of source URLs by consulting the upstream Citation-DB agent for each source's reputability and rolling them up into an overall verdict.",
    inputSchema: {
      type: "object",
      properties: {
        claim: { type: "string", description: "the claim being verified" },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "URLs (or hostnames) supporting the claim",
        },
      },
      required: ["claim", "sources"],
    },
    async handler(args) {
      const claim = String(args.claim ?? "");
      const sources = Array.isArray(args.sources)
        ? (args.sources as string[])
        : [];
      const citationPeer = readPeerId("citation-db");
      const lookup = await callMcp<LookupResponse>({
        axlUrl: AXL_URL,
        peerId: citationPeer,
        service: "citation-db",
        tool: "lookup",
        args: { urls: sources },
        tracer,
      });
      const verdict = judge(lookup.verdicts);
      return { claim, ...verdict, sources: lookup.verdicts };
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
