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

// Copies baggage entries onto every span at start so the OTel sidecar can
// read `originator_peer_id` and route the span. This is the standard
// OTel "BaggageSpanProcessor" pattern from the OTel JS contrib repo.
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

export function initOtel(serviceName: string): Tracer {
  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
  const provider = new NodeTracerProvider({
    resource: new Resource({ "service.name": serviceName }),
    spanProcessors: [
      new BaggageSpanProcessor(),
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
