import {
  propagation,
  trace,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span as SDKSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { EventBus } from "./sse.ts";

// Standard BaggageSpanProcessor: copies baggage entries onto every span at
// start so the OTel sidecar sees `originator_peer_id` as a span attribute.
class BaggageSpanProcessor implements SpanProcessor {
  onStart(span: SDKSpan, parentContext: Context): void {
    const baggage = propagation.getBaggage(parentContext);
    if (!baggage) return;
    for (const [k, e] of baggage.getAllEntries()) {
      span.setAttribute(k, e.value);
    }
  }
  onEnd(_: ReadableSpan): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

// Per SPEC, the live mesh-activity panel is "derived from the same OTel
// spans that flow to the sidecar." This processor pushes a public event
// for every MCP tool span the editor itself creates, so the frontend
// timeline tracks the workflow.
class SsePublisherSpanProcessor implements SpanProcessor {
  constructor(private readonly bus: EventBus) {}

  onStart(span: SDKSpan, _parentContext: Context): void {
    if (!isPublicSpan(span)) return;
    this.bus.publish({
      type: "span-start",
      span: {
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        attributes: extractAttrs(span),
      },
    });
  }

  onEnd(span: ReadableSpan): void {
    if (!isPublicSpan(span)) return;
    const startNs = span.startTime[0] * 1_000_000_000 + span.startTime[1];
    const endNs = span.endTime[0] * 1_000_000_000 + span.endTime[1];
    this.bus.publish({
      type: "span-end",
      span: {
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        durationMs: (endNs - startNs) / 1_000_000,
        statusCode: span.status.code,
        statusMessage: span.status.message,
        attributes: extractAttrs(span),
      },
    });
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function isPublicSpan(span: ReadableSpan | SDKSpan): boolean {
  const a = (span as ReadableSpan).attributes ?? {};
  return Boolean(a["mcp.tool"] || a["mcp.service"] || a["editor.tool"]);
}

function extractAttrs(span: ReadableSpan | SDKSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const attrs = (span as ReadableSpan).attributes ?? {};
  for (const k of [
    "mcp.tool",
    "mcp.service",
    "rpc.system",
    "peer.id",
    "editor.tool",
    "originator_peer_id",
  ]) {
    if (attrs[k] !== undefined) out[k] = attrs[k];
  }
  return out;
}

export function initOtel(serviceName: string, bus: EventBus): Tracer {
  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
  const provider = new NodeTracerProvider({
    resource: new Resource({ "service.name": serviceName }),
    spanProcessors: [
      new BaggageSpanProcessor(),
      new SsePublisherSpanProcessor(bus),
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
      ),
    ],
  });
  provider.register({
    propagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  });
  return trace.getTracer(serviceName);
}
