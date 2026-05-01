// Minimal OTLP/HTTP JSON types — only the fields the sidecar reads or
// preserves while routing. The rest of the payload is passed through as-is.
// Spec: https://opentelemetry.io/docs/specs/otlp/

export type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  boolValue?: boolean;
  doubleValue?: number;
  arrayValue?: { values: AnyValue[] };
  kvlistValue?: { values: KeyValue[] };
  bytesValue?: string;
};

export type KeyValue = { key: string; value: AnyValue };

export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes?: KeyValue[];
  // Other OTLP fields (kind, times, events, links, status…) are preserved
  // structurally but not introspected.
  [k: string]: unknown;
};

export type ScopeSpans = {
  scope?: { name?: string; version?: string };
  spans?: Span[];
  schemaUrl?: string;
};

export type ResourceSpans = {
  resource?: { attributes?: KeyValue[]; droppedAttributesCount?: number };
  scopeSpans?: ScopeSpans[];
  schemaUrl?: string;
};

export type ExportTraceServiceRequest = {
  resourceSpans?: ResourceSpans[];
};

export function getStringAttribute(
  attrs: KeyValue[] | undefined,
  key: string,
): string | undefined {
  if (!attrs) return undefined;
  for (const a of attrs) {
    if (a.key === key) return a.value.stringValue;
  }
  return undefined;
}

export function countSpans(req: ExportTraceServiceRequest): number {
  let n = 0;
  for (const rs of req.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      n += ss.spans?.length ?? 0;
    }
  }
  return n;
}
