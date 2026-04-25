import Anthropic from "@anthropic-ai/sdk";
import { initOtel } from "./otel.ts";
import { orchestrate } from "./orchestrator.ts";
import { EventBus } from "./sse.ts";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "editor";
const AXL_URL = process.env.AXL_URL ?? "http://127.0.0.1:9002";
const PORT = Number(process.env.PORT ?? 8080);

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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;

function sseStream(req: Request): Response {
  let unsubscribe: (() => void) | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "hello", ts: Date.now(), peer_id: ourPeerId })}\n\n`,
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

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(`${PUBLIC_DIR}${rel.replace(/^\//, "")}`);
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }
  return new Response(file);
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ ok: true, peer_id: ourPeerId });
    }

    if (url.pathname === "/events" && req.method === "GET") {
      return sseStream(req);
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
      try {
        const text = await orchestrate({
          prompt,
          ourPeerId,
          axlUrl: AXL_URL,
          tracer,
          bus,
          anthropic,
        });
        return Response.json({ text });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname);
    }

    return new Response("method not allowed", { status: 405 });
  },
});
