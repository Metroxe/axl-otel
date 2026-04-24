import { parseArgs } from "node:util";
import { AxlClient, type RecvMessage } from "./axl.ts";
import type { ExportTraceServiceRequest } from "./otlp.ts";
import { startPoller } from "./poller.ts";
import { startReceiver } from "./receiver.ts";
import { routeSpans } from "./router.ts";

const HELP = `axl-otel — OTLP sidecar for AXL meshes

Usage: axl-otel [options]

Options:
  --receive               Also poll AXL /recv and forward inbound spans to Jaeger.
  --axl-url <url>         AXL HTTP API base URL.            [env AXL_URL, default http://localhost:9002]
  --jaeger-url <url>      Local Jaeger OTLP HTTP base URL.  [env JAEGER_OTLP_URL, default http://localhost:4318]
  --listen-host <host>    OTLP receiver bind host.          [env OTLP_LISTEN_HOST, default localhost]
  --listen-port <port>    OTLP receiver bind port.          [env OTLP_LISTEN_PORT, default 4318]
  --poll-interval-ms <n>  /recv poll interval (--receive).  [default 1000]
  -h, --help              Show this help.
`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    receive: { type: "boolean", default: false },
    "axl-url": { type: "string" },
    "jaeger-url": { type: "string" },
    "listen-host": { type: "string" },
    "listen-port": { type: "string" },
    "poll-interval-ms": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const axlUrl =
  values["axl-url"] ?? process.env.AXL_URL ?? "http://localhost:9002";
const jaegerUrl =
  values["jaeger-url"] ??
  process.env.JAEGER_OTLP_URL ??
  "http://localhost:4318";
const listenHost =
  values["listen-host"] ?? process.env.OTLP_LISTEN_HOST ?? "localhost";
const listenPort = Number(
  values["listen-port"] ?? process.env.OTLP_LISTEN_PORT ?? "4318",
);
const pollIntervalMs = Number(values["poll-interval-ms"] ?? "1000");
const receiveMode = values.receive;

const axl = new AxlClient({ baseUrl: axlUrl });
const ourPeerId = await axl.getPeerId();
console.log(
  `axl-otel: peer ${ourPeerId.slice(0, 12)}…  axl=${axlUrl}  jaeger=${jaegerUrl}  receive=${receiveMode}`,
);

async function forwardToJaeger(payload: ExportTraceServiceRequest): Promise<void> {
  const res = await fetch(`${jaegerUrl}/v1/traces`, {
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

startReceiver({
  host: listenHost,
  port: listenPort,
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

if (receiveMode) {
  startPoller({
    axl,
    intervalMs: pollIntervalMs,
    async onMessage(msg) {
      // AXL /recv envelope format is defined by AXL; pull the payload out
      // wherever it lands. We sent JSON via /send, so we expect to find
      // OTLP JSON here too.
      const payload = extractOtlpPayload(msg);
      if (!payload) return;
      await forwardToJaeger(payload);
    },
  });
}

function extractOtlpPayload(msg: RecvMessage): ExportTraceServiceRequest | null {
  for (const key of ["data", "body", "payload", "message"]) {
    const v = msg[key];
    if (v && typeof v === "object") return v as ExportTraceServiceRequest;
    if (typeof v === "string") {
      try {
        return JSON.parse(v) as ExportTraceServiceRequest;
      } catch {
        // fallthrough
      }
    }
  }
  if ("resourceSpans" in msg) return msg as ExportTraceServiceRequest;
  return null;
}
