// Thin client over AXL's local HTTP API at e.g. http://localhost:9002.
// Reference: https://github.com/gensyn-ai/axl/blob/main/docs/api.md

export type AxlConfig = { baseUrl: string };

export class AxlClient {
  constructor(private readonly cfg: AxlConfig) {}

  async getPeerId(): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/topology`);
    if (!res.ok) {
      throw new Error(`AXL /topology failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const id = (body.peer_id ?? body.peerId ?? body.self ?? body.id) as
      | string
      | undefined;
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

  // AXL's /recv envelope format is determined by AXL itself; we treat each
  // entry as opaque here and let the caller pull the payload out.
  async recv(): Promise<unknown[]> {
    const res = await fetch(`${this.cfg.baseUrl}/recv`);
    if (!res.ok) {
      throw new Error(`AXL /recv failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as unknown;
    if (Array.isArray(body)) return body;
    if (body && typeof body === "object" && "messages" in body) {
      const msgs = (body as { messages: unknown }).messages;
      if (Array.isArray(msgs)) return msgs;
    }
    return [];
  }
}
