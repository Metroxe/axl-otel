// Tiny in-process pub/sub used to fan out workflow events to every SSE
// subscriber. Each event is opaque JSON; the frontend renders by `type`.

export type Event = {
  type: string;
  ts: number;
  [k: string]: unknown;
};

type Subscriber = (event: Event) => void;

export class EventBus {
  private subs = new Set<Subscriber>();

  publish(event: { type: string; ts?: number; [k: string]: unknown }): void {
    const e: Event = { ...event, ts: event.ts ?? Date.now() };
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch (err) {
        console.error("sse: subscriber threw:", err);
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
