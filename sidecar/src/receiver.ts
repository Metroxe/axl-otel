import type { ExportTraceServiceRequest } from "./otlp.ts";

export type TracesResult = {
  rejectedSpans: number;
  errorMessage?: string;
};

export type ReceiverOptions = {
  host: string;
  port: number;
  onTraces: (req: ExportTraceServiceRequest) => Promise<TracesResult>;
};

// OTLP/HTTP receiver. Accepts JSON-encoded ExportTraceServiceRequest at
// POST /v1/traces. Protobuf encoding is intentionally out of scope for v1.
export function startReceiver(opts: ReceiverOptions) {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/v1/traces") {
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return new Response("only application/json is supported", {
            status: 415,
          });
        }
        let payload: ExportTraceServiceRequest;
        try {
          payload = (await req.json()) as ExportTraceServiceRequest;
        } catch {
          return new Response("invalid JSON", { status: 400 });
        }
        let result: TracesResult;
        try {
          result = await opts.onTraces(payload);
        } catch (err) {
          console.error("OTLP handler error:", err);
          return new Response("internal error", { status: 500 });
        }
        const partialSuccess =
          result.rejectedSpans > 0
            ? {
                rejectedSpans: result.rejectedSpans,
                errorMessage: result.errorMessage ?? "",
              }
            : {};
        return Response.json({ partialSuccess });
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok");
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.log(
    `axl-otel: OTLP receiver listening on http://${server.hostname}:${server.port}`,
  );
  return server;
}
