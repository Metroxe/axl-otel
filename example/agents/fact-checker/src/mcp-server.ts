import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";

// Minimal MCP-over-HTTP JSON-RPC 2.0 server. Handles `tools/list` and
// `tools/call`. Reads W3C `traceparent` and `baggage` from `params._meta`
// per the OTel MCP semantic conventions and runs the tool body under that
// propagated context, so spans inherit the originator's baggage.

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

type JsonRpcReq = {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: { _meta?: Record<string, string>; [k: string]: unknown };
};

export function startMcpServer(opts: {
  port: number;
  serviceName: string;
  tools: ToolDef[];
  tracer: Tracer;
}): void {
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));

  Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp") {
        return new Response("not found", { status: 404 });
      }
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      let body: JsonRpcReq;
      try {
        body = (await req.json()) as JsonRpcReq;
      } catch {
        return jsonRpcError(null, -32700, "parse error");
      }

      const meta = (body.params?._meta ?? {}) as Record<string, string>;
      const ctx = propagation.extract(ROOT_CONTEXT, meta);

      return await context.with(ctx, async () => {
        const span = opts.tracer.startSpan(`mcp.${body.method}`, {
          kind: SpanKind.SERVER,
          attributes: { "mcp.service": opts.serviceName, "rpc.system": "mcp" },
        });
        try {
          if (body.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: opts.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema,
                })),
              },
            });
          }
          if (body.method === "tools/call") {
            const name = body.params?.name as string | undefined;
            const args = (body.params?.arguments ?? {}) as Record<
              string,
              unknown
            >;
            if (!name || !toolsByName.has(name)) {
              return jsonRpcError(
                body.id,
                -32601,
                `unknown tool: ${name ?? "(none)"}`,
              );
            }
            const tool = toolsByName.get(name)!;
            const toolSpan = opts.tracer.startSpan(`tool.${name}`, {
              kind: SpanKind.INTERNAL,
            });
            try {
              const result = await context.with(
                trace.setSpan(context.active(), toolSpan),
                () => tool.handler(args),
              );
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  content: [
                    { type: "text", text: JSON.stringify(result) },
                  ],
                },
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              toolSpan.setStatus({ code: SpanStatusCode.ERROR, message });
              return jsonRpcError(body.id, -32000, message);
            } finally {
              toolSpan.end();
            }
          }
          return jsonRpcError(body.id, -32601, `unknown method: ${body.method}`);
        } finally {
          span.end();
        }
      });
    },
  });

  console.log(
    `mcp: ${opts.serviceName} listening on 127.0.0.1:${opts.port}/mcp`,
  );
}

function jsonRpcError(
  id: number | string | null,
  code: number,
  message: string,
): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}
