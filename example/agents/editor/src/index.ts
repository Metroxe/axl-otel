const AXL_URL = process.env.AXL_URL ?? "http://localhost:9002";
const PORT = Number(process.env.PORT ?? 8080);

type Topology = {
  our_public_key: string;
  peers: Array<{ public_key: string; up: boolean; uri?: string }>;
};

async function getTopology(): Promise<Topology> {
  const res = await fetch(`${AXL_URL}/topology`);
  if (!res.ok) {
    throw new Error(`AXL /topology ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as {
    our_public_key: string;
    peers: Topology["peers"] | null;
  };
  return { our_public_key: raw.our_public_key, peers: raw.peers ?? [] };
}

async function waitForAxl(timeoutMs = 30_000): Promise<Topology> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await getTopology();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`gave up waiting for AXL at ${AXL_URL}: ${String(lastErr)}`);
}

const topology = await waitForAxl();
console.log(
  `editor: connected to AXL  peer=${topology.our_public_key.slice(0, 12)}…  peers=${topology.peers.length}`,
);

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      try {
        const t = await getTopology();
        return Response.json({
          ok: true,
          peer_id: t.our_public_key,
          peers: t.peers.length,
        });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 503 });
      }
    }
    return new Response("editor agent — workflow stub\n", {
      headers: { "Content-Type": "text/plain" },
    });
  },
});

console.log(`editor: listening on :${PORT}`);
