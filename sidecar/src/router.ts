import {
  type ExportTraceServiceRequest,
  type ResourceSpans,
  type ScopeSpans,
  type Span,
  getStringAttribute,
} from "./otlp.ts";

export const ORIGINATOR_ATTR = "originator_peer_id";

export type RouteResult = {
  local: ExportTraceServiceRequest | null;
  remote: Map<string, ExportTraceServiceRequest>;
};

// Splits an inbound OTLP request into one envelope destined for the local
// Jaeger (spans the originator wants to see locally) and one envelope per
// remote peer that should receive its spans via AXL /send.
export function routeSpans(
  req: ExportTraceServiceRequest,
  ourPeerId: string,
): RouteResult {
  const localResourceSpans: ResourceSpans[] = [];
  const remoteResourceSpans = new Map<string, ResourceSpans[]>();

  for (const rs of req.resourceSpans ?? []) {
    const localScopes: ScopeSpans[] = [];
    const remoteScopes = new Map<string, ScopeSpans[]>();

    for (const ss of rs.scopeSpans ?? []) {
      const localSpans: Span[] = [];
      const remoteSpans = new Map<string, Span[]>();

      for (const span of ss.spans ?? []) {
        const originator = getStringAttribute(span.attributes, ORIGINATOR_ATTR);
        if (!originator || originator === ourPeerId) {
          localSpans.push(span);
        } else {
          let bucket = remoteSpans.get(originator);
          if (!bucket) {
            bucket = [];
            remoteSpans.set(originator, bucket);
          }
          bucket.push(span);
        }
      }

      if (localSpans.length > 0) {
        localScopes.push({ ...ss, spans: localSpans });
      }
      for (const [peerId, spans] of remoteSpans) {
        let scopes = remoteScopes.get(peerId);
        if (!scopes) {
          scopes = [];
          remoteScopes.set(peerId, scopes);
        }
        scopes.push({ ...ss, spans });
      }
    }

    if (localScopes.length > 0) {
      localResourceSpans.push({ ...rs, scopeSpans: localScopes });
    }
    for (const [peerId, scopes] of remoteScopes) {
      let bucket = remoteResourceSpans.get(peerId);
      if (!bucket) {
        bucket = [];
        remoteResourceSpans.set(peerId, bucket);
      }
      bucket.push({ ...rs, scopeSpans: scopes });
    }
  }

  const remote = new Map<string, ExportTraceServiceRequest>();
  for (const [peerId, resourceSpans] of remoteResourceSpans) {
    remote.set(peerId, { resourceSpans });
  }

  return {
    local: localResourceSpans.length > 0 ? { resourceSpans: localResourceSpans } : null,
    remote,
  };
}
