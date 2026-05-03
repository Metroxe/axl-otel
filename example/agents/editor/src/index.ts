import Anthropic from "@anthropic-ai/sdk";
import { SpanKind } from "@opentelemetry/api";
import { initOtel } from "./otel.ts";
import { orchestrate } from "./orchestrator.ts";
import { EventBus } from "./sse.ts";
import {
  publishInboundSpans,
  type ExportTraceServiceRequest,
} from "./inbound-spans.ts";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "editor";
const AXL_URL = process.env.AXL_URL ?? "http://127.0.0.1:9002";
const PORT = Number(process.env.PORT ?? 8080);
const JAEGER_UI_URL = process.env.JAEGER_UI_URL ?? "http://localhost:16686";
const RATE_LIMIT_PER_IP_HOUR = Number(process.env.RATE_LIMIT_PER_IP_HOUR ?? 3);
const RATE_LIMIT_GLOBAL_DAY = Number(process.env.RATE_LIMIT_GLOBAL_DAY ?? 50);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 60_000);
const TOOL_STALE_MS = Number(process.env.TOOL_STALE_MS ?? 15_000);
// Jaeger's HTTP query API. Used by the server to poll for trace
// availability after a run completes (see pollTraceAvailable). The browser
// always uses JAEGER_UI_URL; this one only needs to be reachable from
// inside the editor container.
const JAEGER_QUERY_URL =
  process.env.JAEGER_QUERY_URL ?? "http://jaeger:16686";
const TRACE_POLL_INTERVAL_MS = Number(
  process.env.TRACE_POLL_INTERVAL_MS ?? 1_000,
);
const TRACE_POLL_TIMEOUT_MS = Number(
  process.env.TRACE_POLL_TIMEOUT_MS ?? 60_000,
);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ipRequestTimes = new Map<string, number[]>();
const dailyRunTimes: number[] = [];

function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? "unknown";
  return "unknown";
}

function checkAndRecordRateLimit(ip: string): {
  ok: boolean;
  status?: number;
  error?: string;
  retryAfterSec?: number;
} {
  const now = Date.now();

  while (dailyRunTimes.length > 0 && dailyRunTimes[0]! < now - DAY_MS) {
    dailyRunTimes.shift();
  }
  if (dailyRunTimes.length >= RATE_LIMIT_GLOBAL_DAY) {
    const oldest = dailyRunTimes[0]!;
    return {
      ok: false,
      status: 503,
      error:
        "Daily demo quota reached. Please try again tomorrow, or run the example locally — see the project README.",
      retryAfterSec: Math.ceil((oldest + DAY_MS - now) / 1000),
    };
  }

  const recent = (ipRequestTimes.get(ip) ?? []).filter(
    (t) => t > now - HOUR_MS,
  );
  if (recent.length >= RATE_LIMIT_PER_IP_HOUR) {
    const oldest = recent[0]!;
    const wait = Math.ceil((oldest + HOUR_MS - now) / 60_000);
    return {
      ok: false,
      status: 429,
      error: `Too many runs from this IP. Try again in ~${wait} minute${wait === 1 ? "" : "s"}.`,
      retryAfterSec: Math.ceil((oldest + HOUR_MS - now) / 1000),
    };
  }

  recent.push(now);
  ipRequestTimes.set(ip, recent);
  dailyRunTimes.push(now);
  return { ok: true };
}

type RequestHistoryEntry = {
  traceId: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "ok" | "error" | "timeout";
  text?: string;
  error?: string;
  // Flips true once Jaeger's query API returns the trace, so the UI can
  // mark the per-run "trace abcd1234… →" link as clickable instead of
  // "indexing…". Stays false if polling times out.
  traceReady?: boolean;
};

const HISTORY_LIMIT = 50;
const requestHistory: RequestHistoryEntry[] = [];

function addHistoryEntry(entry: RequestHistoryEntry): void {
  requestHistory.unshift(entry);
  if (requestHistory.length > HISTORY_LIMIT) {
    requestHistory.length = HISTORY_LIMIT;
  }
}

function updateHistoryEntry(
  traceId: string,
  patch: Partial<RequestHistoryEntry>,
): void {
  const entry = requestHistory.find((e) => e.traceId === traceId);
  if (entry) Object.assign(entry, patch);
}

// Tracks in-flight polls so concurrent runs of the same traceId don't
// double-poll, and so a second /run for the same trace won't spawn a
// duplicate background task.
const tracesBeingPolled = new Set<string>();

async function pollTraceAvailable(traceId: string): Promise<void> {
  if (tracesBeingPolled.has(traceId)) return;
  tracesBeingPolled.add(traceId);
  const deadline = Date.now() + TRACE_POLL_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(
          `${JAEGER_QUERY_URL}/api/traces/${traceId}`,
        );
        if (res.ok) {
          const json = (await res.json()) as { data?: unknown[] };
          if (Array.isArray(json.data) && json.data.length > 0) {
            updateHistoryEntry(traceId, { traceReady: true });
            bus.publish({ type: "trace-ready", traceId });
            return;
          }
        }
      } catch {
        // network blip; just retry
      }
      await new Promise((r) => setTimeout(r, TRACE_POLL_INTERVAL_MS));
    }
    // Polling timed out — leave traceReady undefined; the UI will keep
    // showing the link as "indexing…" but it's still clickable in case
    // Jaeger eventually catches up.
  } finally {
    tracesBeingPolled.delete(traceId);
  }
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

const bus = new EventBus();
const tracer = initOtel(SERVICE_NAME, bus);
const ourPeerId = await waitForAxl();
console.log(
  `editor: AXL ready  peer=${ourPeerId.slice(0, 12)}…  serving on :${PORT}`,
);

// Emit a one-shot startup span so the editor service shows up in the local
// Jaeger immediately, without waiting for the first page load. Jaeger only
// learns a service exists once it's seen a span tagged with that name.
tracer
  .startSpan("editor.startup", {
    kind: SpanKind.INTERNAL,
    attributes: { "peer.id": ourPeerId },
  })
  .end();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// In compiled mode (`bun build --compile`) `import.meta.url` points to a
// virtual path inside the binary, so we let the Dockerfile pin PUBLIC_DIR
// to an absolute on-disk location. Local dev still falls back to the
// relative-to-source resolution.
const PUBLIC_DIR =
  process.env.PUBLIC_DIR ?? new URL("../public/", import.meta.url).pathname;

function sseStream(req: Request): Response {
  let unsubscribe: (() => void) | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "hello",
            ts: Date.now(),
            peer_id: ourPeerId,
            jaeger_ui_url: JAEGER_UI_URL,
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "history",
            ts: Date.now(),
            entries: requestHistory,
          })}\n\n`,
        ),
      );
      unsubscribe = bus.subscribe((event) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // controller closed; subscription will be cleaned up below.
        }
      });
      const close = () => {
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function serveStatic(
  pathname: string,
  userAgent: string | null,
): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(`${PUBLIC_DIR}${rel.replace(/^\//, "")}`);
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }
  // Emit a span on every page load so the editor service registers with
  // Jaeger immediately on first visit, not just after the first /run.
  if (rel === "/index.html") {
    const span = tracer.startSpan("editor.page-load", {
      kind: SpanKind.SERVER,
      attributes: {
        "http.method": "GET",
        "http.target": pathname,
        "http.user_agent": userAgent ?? "",
      },
    });
    span.end();
  }
  return new Response(file);
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  // SSE streams on /events stay open indefinitely, and /run can run for
  // longer than Bun's 10s default while Claude is in its tool-use loop.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ ok: true, peer_id: ourPeerId });
    }

    if (url.pathname === "/events" && req.method === "GET") {
      return sseStream(req);
    }

    // Sidecar fan-out: --inbound-callback-url POSTs OTLP/JSON payloads it
    // pulled off AXL /recv. We translate them into span-start/span-end SSE
    // events so the live mesh visual reflects remote-peer activity.
    // Localhost-only because the sidecar always lives in this container.
    if (url.pathname === "/internal/inbound-spans" && req.method === "POST") {
      const remote = req.headers.get("x-forwarded-for") ?? "";
      if (remote && !remote.startsWith("127.")) {
        return new Response("forbidden", { status: 403 });
      }
      let payload: ExportTraceServiceRequest;
      try {
        payload = (await req.json()) as ExportTraceServiceRequest;
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      const count = publishInboundSpans(bus, payload);
      return Response.json({ ok: true, published: count });
    }

    if (url.pathname === "/run" && req.method === "POST") {
      let body: { prompt?: unknown };
      try {
        body = (await req.json()) as { prompt?: unknown };
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) {
        return Response.json(
          { error: "prompt is required" },
          { status: 400 },
        );
      }
      const ip = clientIp(req);
      const limit = checkAndRecordRateLimit(ip);
      if (!limit.ok) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (limit.retryAfterSec) {
          headers["Retry-After"] = String(limit.retryAfterSec);
        }
        return new Response(JSON.stringify({ error: limit.error }), {
          status: limit.status ?? 429,
          headers,
        });
      }
      const startedAt = Date.now();
      let runTraceId: string | undefined;
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort(
          new Error(
            `editor timed out after ${RUN_TIMEOUT_MS / 1000}s with no response`,
          ),
        );
      }, RUN_TIMEOUT_MS);
      try {
        const { text, traceId } = await orchestrate({
          prompt,
          ourPeerId,
          axlUrl: AXL_URL,
          tracer,
          bus,
          anthropic,
          signal: controller.signal,
          toolStaleMs: TOOL_STALE_MS,
          onWorkflowStart: (tid) => {
            runTraceId = tid;
            addHistoryEntry({
              traceId: tid,
              prompt,
              startedAt,
              status: "running",
            });
            bus.publish({
              type: "request-start",
              traceId: tid,
              prompt,
              startedAt,
              timeoutMs: RUN_TIMEOUT_MS,
            });
          },
        });
        updateHistoryEntry(traceId, {
          status: "ok",
          text,
          endedAt: Date.now(),
        });
        // Poll Jaeger for trace availability so the UI can flip the link
        // from "indexing…" to clickable once the spans actually land.
        void pollTraceAvailable(traceId);
        return Response.json({ text, traceId });
      } catch (err) {
        const aborted = controller.signal.aborted;
        const reason = controller.signal.reason;
        const message = aborted
          ? reason instanceof Error
            ? reason.message
            : String(reason ?? "timed out")
          : err instanceof Error
            ? err.message
            : String(err);
        if (runTraceId) {
          updateHistoryEntry(runTraceId, {
            status: aborted ? "timeout" : "error",
            error: message,
            endedAt: Date.now(),
          });
          // Even failed runs produce trace data — the workflow span lands
          // in Jaeger with status=error, so still poll for availability.
          void pollTraceAvailable(runTraceId);
        }
        return Response.json(
          { error: message, traceId: runTraceId, timeout: aborted },
          { status: aborted ? 504 : 500 },
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, req.headers.get("user-agent"));
    }

    return new Response("method not allowed", { status: 405 });
  },
});
