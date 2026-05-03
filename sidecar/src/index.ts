import { Command, Option } from "commander";
import { AxlClient, type RecvMessage } from "./axl.ts";
import { countSpans, type ExportTraceServiceRequest } from "./otlp.ts";
import { startPoller } from "./poller.ts";
import { startReceiver } from "./receiver.ts";
import { routeSpans } from "./router.ts";

type CliOptions = {
  receive: boolean;
  axlUrl: string;
  otlpUrl: string;
  listenHost: string;
  listenPort: number;
  pollIntervalMs: number;
  inboundCallbackUrl?: string;
};

async function run(opts: CliOptions): Promise<void> {
  const axl = new AxlClient({ baseUrl: opts.axlUrl });
  const ourPeerId = await axl.getPeerId();
  console.log(
    `axl-otel: peer ${ourPeerId.slice(0, 12)}…  axl=${opts.axlUrl}  otlp=${opts.otlpUrl}  receive=${opts.receive}  inbound-callback=${opts.inboundCallbackUrl ?? "(none)"}`,
  );

  async function forwardToBackend(
    payload: ExportTraceServiceRequest,
  ): Promise<void> {
    const res = await fetch(`${opts.otlpUrl}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(
        `OTLP backend forward failed: ${res.status} ${await res.text()}`,
      );
    }
  }

  const server = startReceiver({
    host: opts.listenHost,
    port: opts.listenPort,
    async onTraces(req) {
      const { local, remote } = routeSpans(req, ourPeerId);
      let rejectedSpans = 0;
      const errors: string[] = [];

      const tasks: Promise<unknown>[] = [];
      if (local) {
        const count = countSpans(local);
        tasks.push(
          forwardToBackend(local).catch((err) => {
            rejectedSpans += count;
            const msg = `OTLP backend forward dropped ${count} span(s): ${err}`;
            errors.push(msg);
            console.error(`axl-otel: ${msg}`);
          }),
        );
      }
      for (const [peerId, payload] of remote) {
        const count = countSpans(payload);
        tasks.push(
          axl.send(peerId, JSON.stringify(payload)).catch((err) => {
            rejectedSpans += count;
            const msg = `AXL /send to ${peerId.slice(0, 12)}… dropped ${count} span(s): ${err}`;
            errors.push(msg);
            console.error(`axl-otel: ${msg}`);
          }),
        );
      }
      await Promise.all(tasks);
      return {
        rejectedSpans,
        errorMessage: errors.length > 0 ? errors.join("; ") : undefined,
      };
    },
  });

  // Optional fan-out for inbound spans. When set, every successfully-decoded
  // /recv payload is also POSTed to this URL — used by the example editor to
  // surface remote-peer activity in its live mesh panel without piping every
  // span through Jaeger first.
  async function fanoutToCallback(
    payload: ExportTraceServiceRequest,
  ): Promise<void> {
    if (!opts.inboundCallbackUrl) return;
    const count = countSpans(payload);
    try {
      const res = await fetch(opts.inboundCallbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error(
          `axl-otel: inbound callback ${opts.inboundCallbackUrl} returned ${res.status} for ${count} span(s)`,
        );
      } else {
        console.log(
          `axl-otel: inbound callback delivered ${count} span(s)`,
        );
      }
    } catch (err) {
      console.error(
        `axl-otel: inbound callback ${opts.inboundCallbackUrl} failed:`,
        err,
      );
    }
  }

  let stopPoller: (() => void) | null = null;
  if (opts.receive) {
    stopPoller = startPoller({
      axl,
      intervalMs: opts.pollIntervalMs,
      async onMessage(msg) {
        const payload = extractOtlpPayload(msg);
        if (!payload) return;
        await Promise.all([forwardToBackend(payload), fanoutToCallback(payload)]);
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
    "Also poll AXL /recv and forward inbound spans to the local OTLP backend",
    false,
  )
  .addOption(
    new Option("--axl-url <url>", "AXL HTTP API base URL")
      .env("AXL_URL")
      .default("http://localhost:9002"),
  )
  .addOption(
    new Option("--otlp-url <url>", "Local OTLP backend HTTP base URL (Jaeger, Tempo, Datadog, etc.)")
      .env("OTLP_URL")
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
  .addOption(
    new Option(
      "--inbound-callback-url <url>",
      "Optional URL to POST decoded /recv payloads to alongside the OTLP backend (used for live UI fan-out)",
    ).env("INBOUND_CALLBACK_URL"),
  )
  .action((opts: CliOptions) => run(opts));

await program.parseAsync();
