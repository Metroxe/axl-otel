import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Outbound MCP client: POSTs JSON-RPC to AXL's `/mcp/{peer}/{service}`,
// injecting W3C traceparent and baggage into params._meta per the OTel
// MCP semantic conventions. Same shape as the researcher / fact-checker
// client; duplicated by design (no shared library — agents stand alone).

export type CallMcpOptions = {
  axlUrl: string;
  peerId: string;
  service: string;
  tool: string;
  args: Record<string, unknown>;
  tracer: Tracer;
};

export async function callMcp<T = unknown>(opts: CallMcpOptions): Promise<T> {
  const span = opts.tracer.startSpan(`mcp.call ${opts.service}.${opts.tool}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "rpc.system": "mcp",
      "mcp.service": opts.service,
      "mcp.tool": opts.tool,
      "peer.id": opts.peerId,
    },
  });

  try {
    const meta: Record<string, string> = {};
    propagation.inject(context.active(), meta);

    const body = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: opts.tool, arguments: opts.args, _meta: meta },
    };

    const url = `${opts.axlUrl}/mcp/${opts.peerId}/${opts.service}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`MCP call ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      result?: { content?: Array<{ type: string; text?: string }> };
      error?: { code: number; message: string };
    };
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    const text = json.result?.content?.find((c) => c.type === "text")?.text;
    if (!text) return (json.result ?? null) as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

const PEERS_DIR = process.env.AXL_PEERS_DIR ?? "/etc/axl/peers";

export function readPeerId(name: string, dir: string = PEERS_DIR): string {
  const raw = readFileSync(join(dir, `${name}.id`), "utf8").trim();
  if (!raw) throw new Error(`empty peer id for ${name} at ${dir}`);
  return raw;
}
