import { z } from "zod";

// Thin client over AXL's local HTTP API at e.g. http://localhost:9002.
// Reference: https://github.com/gensyn-ai/axl/blob/main/docs/api.md

const TopologySchema = z.object({
  peer_id: z.string().optional(),
  peerId: z.string().optional(),
  self: z.string().optional(),
  id: z.string().optional(),
});

const RecvMessageSchema = z.record(z.string(), z.unknown());
export type RecvMessage = z.infer<typeof RecvMessageSchema>;

const RecvResponseSchema = z.union([
  z.array(RecvMessageSchema),
  z.object({ messages: z.array(RecvMessageSchema) }),
]);

export type AxlConfig = { baseUrl: string };

export class AxlClient {
  constructor(private readonly cfg: AxlConfig) {}

  async getPeerId(): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/topology`);
    if (!res.ok) {
      throw new Error(`AXL /topology failed: ${res.status} ${res.statusText}`);
    }
    const body = TopologySchema.parse(await res.json());
    const id = body.peer_id ?? body.peerId ?? body.self ?? body.id;
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

  async recv(): Promise<RecvMessage[]> {
    const res = await fetch(`${this.cfg.baseUrl}/recv`);
    if (!res.ok) {
      throw new Error(`AXL /recv failed: ${res.status} ${res.statusText}`);
    }
    const body = RecvResponseSchema.parse(await res.json());
    return Array.isArray(body) ? body : body.messages;
  }
}
