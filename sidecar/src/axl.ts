import { z } from "zod";

// Thin client over AXL's local HTTP API at e.g. http://localhost:9002.
// Reference: https://github.com/gensyn-ai/axl/blob/main/docs/api.md

// AXL's real /topology response uses `our_public_key`; keep the older
// aliases as a belt-and-braces fallback in case the upstream field name
// shifts.
const TopologySchema = z
  .object({
    our_public_key: z.string().optional(),
    peer_id: z.string().optional(),
    peerId: z.string().optional(),
    self: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

export type RecvMessage = {
  fromPeerId: string | null;
  body: string;
};

export type AxlConfig = { baseUrl: string };

export class AxlClient {
  constructor(private readonly cfg: AxlConfig) {}

  async getPeerId(): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/topology`);
    if (!res.ok) {
      throw new Error(`AXL /topology failed: ${res.status} ${res.statusText}`);
    }
    const raw = await res.json();
    const body = TopologySchema.parse(raw);
    const id =
      body.our_public_key ??
      body.peer_id ??
      body.peerId ??
      body.self ??
      body.id;
    if (!id) {
      throw new Error(
        `AXL /topology response missing peer ID (got keys: ${Object.keys(body).join(", ")})`,
      );
    }
    return id;
  }

  async send(peerId: string, body: string | Uint8Array): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl}/send`, {
      method: "POST",
      headers: {
        "X-Destination-Peer-Id": peerId,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`AXL /send failed: ${res.status} ${res.statusText}`);
    }
  }

  // Per AXL HTTP API docs:
  //   - 204 No Content — queue empty
  //   - 200 OK — raw body with `X-From-Peer-Id` header (one message per call)
  async recv(): Promise<RecvMessage | null> {
    const res = await fetch(`${this.cfg.baseUrl}/recv`);
    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`AXL /recv failed: ${res.status} ${res.statusText}`);
    }
    const fromPeerId = res.headers.get("X-From-Peer-Id");
    const body = await res.text();
    return { fromPeerId, body };
  }
}
