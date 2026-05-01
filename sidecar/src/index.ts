import { Command, Option } from "commander";
import { AxlClient, type RecvMessage } from "./axl.ts";
import type { ExportTraceServiceRequest } from "./otlp.ts";
import { startPoller } from "./poller.ts";
import { startReceiver } from "./receiver.ts";
import { routeSpans } from "./router.ts";

type CliOptions = {
  receive: boolean;
  axlUrl: string;
  jaegerUrl: string;
  listenHost: string;
  listenPort: number;
  pollIntervalMs: number;
};

async function run(opts: CliOptions): Promise<void> {
  const axl = new AxlClient({ baseUrl: opts.axlUrl });
  const ourPeerId = await axl.getPeerId();
  console.log(
    `axl-otel: peer ${ourPeerId.slice(0, 12)}…  axl=${opts.axlUrl}  jaeger=${opts.jaegerUrl}  receive=${opts.receive}`,
  );

  async function forwardToJaeger(
    payload: ExportTraceServiceRequest,
  ): Promise<void> {
    const res = await fetch(`${opts.jaegerUrl}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(
        `axl-otel: Jaeger forward failed: ${res.status} ${await res.text()}`,
      );
    }
  }

  const server = startReceiver({
    host: opts.listenHost,
    port: opts.listenPort,
    async onTraces(req) {
      const { local, remote } = routeSpans(req, ourPeerId);
      const tasks: Promise<unknown>[] = [];
      if (local) tasks.push(forwardToJaeger(local));
      for (const [peerId, payload] of remote) {
        tasks.push(axl.send(peerId, JSON.stringify(payload)));
      }
      await Promise.allSettled(tasks);
    },
  });

  let stopPoller: (() => void) | null = null;
  if (opts.receive) {
    stopPoller = startPoller({
      axl,
      intervalMs: opts.pollIntervalMs,
      async onMessage(msg) {
        const payload = extractOtlpPayload(msg);
        if (!payload) return;
        await forwardToJaeger(payload);
      },
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`axl-otel: ${signal} received, shutting down`);
    stopPoller?.();
    // server.stop(false) lets in-flight requests drain.
    await server.stop(false);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// The sidecar's `/send` side encodes ExportTraceServiceRequest as JSON, so
// /recv bodies are JSON strings we just need to parse.
function extractOtlpPayload(msg: RecvMessage): ExportTraceServiceRequest | null {
  if (!msg.body) return null;
  try {
    const parsed = JSON.parse(msg.body);
    if (parsed && typeof parsed === "object" && "resourceSpans" in parsed) {
      return parsed as ExportTraceServiceRequest;
    }
  } catch (err) {
    console.error("axl-otel: failed to parse /recv body as JSON:", err);
  }
  return null;
}

const program = new Command();

program
  .name("axl-otel")
  .description("OTLP sidecar for AXL meshes")
  .version("0.1.0")
  .option(
    "--receive",
    "Also poll AXL /recv and forward inbound spans to Jaeger",
    false,
  )
  .addOption(
    new Option("--axl-url <url>", "AXL HTTP API base URL")
      .env("AXL_URL")
      .default("http://localhost:9002"),
  )
  .addOption(
    new Option("--jaeger-url <url>", "Local Jaeger OTLP HTTP base URL")
      .env("JAEGER_OTLP_URL")
      .default("http://localhost:4318"),
  )
  .addOption(
    new Option("--listen-host <host>", "OTLP receiver bind host")
      .env("OTLP_LISTEN_HOST")
      .default("localhost"),
  )
  .addOption(
    new Option("--listen-port <port>", "OTLP receiver bind port")
      .env("OTLP_LISTEN_PORT")
      .default(4318)
      .argParser((v) => Number(v)),
  )
  .addOption(
    new Option("--poll-interval-ms <ms>", "/recv poll interval in --receive mode")
      .default(1000)
      .argParser((v) => Number(v)),
  )
  .action((opts: CliOptions) => run(opts));

await program.parseAsync();
