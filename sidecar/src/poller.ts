import type { AxlClient, RecvMessage } from "./axl.ts";

export type PollerOptions = {
  axl: AxlClient;
  intervalMs: number;
  onMessage: (msg: RecvMessage) => Promise<void>;
};

// Polls AXL /recv on a fixed interval and dispatches each inbound message.
// Returns a stop function.
export function startPoller(opts: PollerOptions): () => void {
  let stopped = false;

  (async () => {
    while (!stopped) {
      try {
        const msgs = await opts.axl.recv();
        for (const msg of msgs) {
          if (stopped) break;
          try {
            await opts.onMessage(msg);
          } catch (err) {
            console.error("axl-otel: inbound message handler error:", err);
          }
        }
      } catch (err) {
        console.error("axl-otel: AXL /recv poll error:", err);
      }
      if (!stopped) await Bun.sleep(opts.intervalMs);
    }
  })();

  return () => {
    stopped = true;
  };
}
