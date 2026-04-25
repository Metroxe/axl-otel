import { describe, expect, test } from "bun:test";
import type { ExportTraceServiceRequest, KeyValue, Span } from "./otlp.ts";
import { ORIGINATOR_ATTR, routeSpans } from "./router.ts";

const OUR_PEER = "a".repeat(64);
const PEER_B = "b".repeat(64);
const PEER_C = "c".repeat(64);

function originatorAttr(peerId: string): KeyValue {
  return { key: ORIGINATOR_ATTR, value: { stringValue: peerId } };
}

function span(name: string, attrs?: KeyValue[]): Span {
  return {
    traceId: name + "-trace",
    spanId: name + "-span",
    name,
    attributes: attrs,
  };
}

function req(...spans: Span[]): ExportTraceServiceRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
        scopeSpans: [{ scope: { name: "test-scope" }, spans }],
      },
    ],
  };
}

function localSpanNames(result: ReturnType<typeof routeSpans>): string[] {
  return (result.local?.resourceSpans ?? [])
    .flatMap((rs) => rs.scopeSpans ?? [])
    .flatMap((ss) => ss.spans ?? [])
    .map((s) => s.name);
}

function remoteSpanNames(
  result: ReturnType<typeof routeSpans>,
  peerId: string,
): string[] {
  const env = result.remote.get(peerId);
  if (!env) return [];
  return (env.resourceSpans ?? [])
    .flatMap((rs) => rs.scopeSpans ?? [])
    .flatMap((ss) => ss.spans ?? [])
    .map((s) => s.name);
}

describe("routeSpans", () => {
  test("spans without originator attribute go local", () => {
    const result = routeSpans(req(span("a")), OUR_PEER);
    expect(localSpanNames(result)).toEqual(["a"]);
    expect(result.remote.size).toBe(0);
  });

  test("spans whose originator matches ours go local", () => {
    const result = routeSpans(
      req(span("a", [originatorAttr(OUR_PEER)])),
      OUR_PEER,
    );
    expect(localSpanNames(result)).toEqual(["a"]);
    expect(result.remote.size).toBe(0);
  });

  test("spans for a remote originator go to that peer's bucket", () => {
    const result = routeSpans(
      req(span("a", [originatorAttr(PEER_B)])),
      OUR_PEER,
    );
    expect(result.local).toBeNull();
    expect([...result.remote.keys()]).toEqual([PEER_B]);
    expect(remoteSpanNames(result, PEER_B)).toEqual(["a"]);
  });

  test("splits a mixed payload across local and multiple remotes", () => {
    const result = routeSpans(
      req(
        span("local-implicit"),
        span("local-explicit", [originatorAttr(OUR_PEER)]),
        span("remote-b-1", [originatorAttr(PEER_B)]),
        span("remote-b-2", [originatorAttr(PEER_B)]),
        span("remote-c", [originatorAttr(PEER_C)]),
      ),
      OUR_PEER,
    );

    expect(localSpanNames(result).sort()).toEqual([
      "local-explicit",
      "local-implicit",
    ]);
    expect(remoteSpanNames(result, PEER_B).sort()).toEqual([
      "remote-b-1",
      "remote-b-2",
    ]);
    expect(remoteSpanNames(result, PEER_C)).toEqual(["remote-c"]);
  });

  test("returns null local and empty remote when input has no spans", () => {
    const result = routeSpans({ resourceSpans: [] }, OUR_PEER);
    expect(result.local).toBeNull();
    expect(result.remote.size).toBe(0);
  });

  test("ignores scopes that contribute no spans to a given destination", () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
          scopeSpans: [
            { scope: { name: "scope-local" }, spans: [span("a")] },
            {
              scope: { name: "scope-remote" },
              spans: [span("b", [originatorAttr(PEER_B)])],
            },
          ],
        },
      ],
    };

    const result = routeSpans(input, OUR_PEER);

    const localScopes = result.local?.resourceSpans?.[0]?.scopeSpans ?? [];
    expect(localScopes.map((s) => s.scope?.name)).toEqual(["scope-local"]);

    const remoteScopes = result.remote.get(PEER_B)?.resourceSpans?.[0]?.scopeSpans ?? [];
    expect(remoteScopes.map((s) => s.scope?.name)).toEqual(["scope-remote"]);
  });

  test("preserves resource attributes and scope metadata on each side", () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "svc-1" } }],
          },
          schemaUrl: "https://example.invalid/schema",
          scopeSpans: [
            {
              scope: { name: "scope-1", version: "1.2.3" },
              schemaUrl: "https://example.invalid/scope-schema",
              spans: [
                span("local"),
                span("remote", [originatorAttr(PEER_B)]),
              ],
            },
          ],
        },
      ],
    };

    const result = routeSpans(input, OUR_PEER);

    const localRs = result.local?.resourceSpans?.[0];
    expect(localRs?.resource?.attributes?.[0]?.key).toBe("service.name");
    expect(localRs?.schemaUrl).toBe("https://example.invalid/schema");
    expect(localRs?.scopeSpans?.[0]?.scope).toEqual({ name: "scope-1", version: "1.2.3" });
    expect(localRs?.scopeSpans?.[0]?.schemaUrl).toBe("https://example.invalid/scope-schema");

    const remoteRs = result.remote.get(PEER_B)?.resourceSpans?.[0];
    expect(remoteRs?.resource?.attributes?.[0]?.key).toBe("service.name");
    expect(remoteRs?.schemaUrl).toBe("https://example.invalid/schema");
    expect(remoteRs?.scopeSpans?.[0]?.scope).toEqual({ name: "scope-1", version: "1.2.3" });
  });

  test("buckets spans across multiple resourceSpans entries", () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc-a" } }] },
          scopeSpans: [{ spans: [span("a", [originatorAttr(PEER_B)])] }],
        },
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc-b" } }] },
          scopeSpans: [{ spans: [span("b", [originatorAttr(PEER_B)])] }],
        },
      ],
    };

    const result = routeSpans(input, OUR_PEER);

    expect(result.local).toBeNull();
    const remote = result.remote.get(PEER_B);
    expect(remote?.resourceSpans?.length).toBe(2);
    expect(remoteSpanNames(result, PEER_B).sort()).toEqual(["a", "b"]);
  });

  test("tolerates missing scopeSpans and spans arrays", () => {
    const input: ExportTraceServiceRequest = {
      resourceSpans: [{ resource: { attributes: [] } }, { scopeSpans: [{}] }],
    };
    const result = routeSpans(input, OUR_PEER);
    expect(result.local).toBeNull();
    expect(result.remote.size).toBe(0);
  });

  test("does not mutate the input request", () => {
    const original = req(
      span("local"),
      span("remote", [originatorAttr(PEER_B)]),
    );
    const snapshot = JSON.parse(JSON.stringify(original));
    routeSpans(original, OUR_PEER);
    expect(original).toEqual(snapshot);
  });
});
