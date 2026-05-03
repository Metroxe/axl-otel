import type { EventBus } from "./sse.ts";

// The sidecar's `--inbound-callback-url` POSTs us OTLP/JSON payloads it
// pulled off AXL `/recv`. We translate each span into the same
// span-start / span-end events the local SsePublisherSpanProcessor emits, so
// the frontend's mesh visual lights up downstream peers from the same
// channel — without us having to wire spans through Jaeger first.
//
// /recv only delivers completed spans, so we synthesise a back-to-back
// span-start + span-end for each one. The frontend treats them
// idempotently.

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  boolValue?: boolean;
  doubleValue?: number;
};
type KeyValue = { key: string; value: AnyValue };
type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  name?: string;
  attributes?: KeyValue[];
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  status?: { code?: number; message?: string };
};
type ResourceSpans = {
  resource?: { attributes?: KeyValue[] };
  scopeSpans?: { spans?: OtlpSpan[] }[];
};
export type ExportTraceServiceRequest = { resourceSpans?: ResourceSpans[] };

// Same allow-list shape the local SsePublisherSpanProcessor uses, plus
// peer.name so the frontend can map a span to a mesh node.
const PUBLIC_ATTR_KEYS = [
  "mcp.tool",
  "mcp.service",
  "rpc.system",
  "peer.id",
  "peer.name",
  "editor.tool",
  "originator_peer_id",
  "gen_ai.system",
  "gen_ai.request.model",
  "gen_ai.response.stop_reason",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read_input_tokens",
  "gen_ai.usage.cache_creation_input_tokens",
  "editor.turn",
  "editor.tool_use.count",
];

function unwrap(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  return undefined;
}

function flatten(attrs: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of attrs ?? []) {
    out[kv.key] = unwrap(kv.value);
  }
  return out;
}

function publicSubset(
  flat: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_ATTR_KEYS) {
    if (flat[k] !== undefined) out[k] = flat[k];
  }
  return out;
}

export function publishInboundSpans(
  bus: EventBus,
  payload: ExportTraceServiceRequest,
): number {
  let published = 0;
  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs = flatten(rs.resource?.attributes);
    const peerName = resourceAttrs["service.name"] as string | undefined;
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const spanAttrs = flatten(span.attributes);
        // Surface the peer name as a span attribute so the frontend can
        // map "this span is from web-search" → reveal the web-search node.
        if (peerName && spanAttrs["peer.name"] === undefined) {
          spanAttrs["peer.name"] = peerName;
        }
        const filtered = publicSubset(spanAttrs);
        // Skip spans that wouldn't drive any UI — keeps the event stream
        // narrow and matches isPublicSpan() over on the local side.
        if (
          !filtered["mcp.service"] &&
          !filtered["mcp.tool"] &&
          !filtered["editor.tool"] &&
          !filtered["gen_ai.system"] &&
          !filtered["peer.name"]
        ) {
          continue;
        }
        const startNs = Number(span.startTimeUnixNano ?? 0);
        const endNs = Number(span.endTimeUnixNano ?? 0);
        const durationMs = endNs > startNs ? (endNs - startNs) / 1_000_000 : 0;
        const base = {
          name: span.name ?? "(unnamed)",
          traceId: span.traceId ?? "",
          spanId: span.spanId ?? "",
          attributes: filtered,
        };
        bus.publish({ type: "span-start", span: base });
        bus.publish({
          type: "span-end",
          span: {
            ...base,
            durationMs,
            statusCode: span.status?.code,
            statusMessage: span.status?.message,
          },
        });
        published += 1;
      }
    }
  }
  return published;
}
