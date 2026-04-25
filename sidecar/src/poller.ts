import type { AxlClient, RecvMessage } from "./axl.ts";

export type PollerOptions = {
  axl: AxlClient;
  intervalMs: number;
  onMessage: (msg: RecvMessage) => Promise<void>;
};

// Polls AXL /recv on a fixed interval and dispatches each inbound message.
// /recv returns at most one message per call (204 when the queue is empty),
// so when we do get a message we immediately poll again to drain bursts
// without waiting out the full interval.
export function startPoller(opts: PollerOptions): () => void {
  let stopped = false;

  (async () => {
    while (!stopped) {
      let msg: RecvMessage | null;
      try {
        msg = await opts.axl.recv();
      } catch (err) {
        console.error("axl-otel: AXL /recv poll error:", err);
        msg = null;
      }
      if (msg) {
        try {
          await opts.onMessage(msg);
        } catch (err) {
          console.error("axl-otel: inbound message handler error:", err);
        }
        continue;
      }
      if (!stopped) await Bun.sleep(opts.intervalMs);
    }
  })();

  return () => {
    stopped = true;
  };
}
