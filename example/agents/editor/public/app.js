const promptEl = document.getElementById("prompt");
const runBtn = document.getElementById("run");
const resultEl = document.getElementById("result");
const eventsEl = document.getElementById("events");
const peerEl = document.getElementById("peer-id");
const historyEl = document.getElementById("history");
const rateWarnEl = document.getElementById("rate-warn");
const aboutDialogEl = document.getElementById("about-dialog");
const aboutBtnEl = document.getElementById("about-btn");
const aboutLinkEl = document.getElementById("about-link");
const aboutCloseEl = document.getElementById("about-close");
const jaegerLinkEls = [
  document.getElementById("jaeger-link"),
  document.getElementById("jaeger-link-2"),
].filter(Boolean);

function openAboutDialog() {
  if (!aboutDialogEl) return;
  if (typeof aboutDialogEl.showModal === "function") {
    if (!aboutDialogEl.open) aboutDialogEl.showModal();
  } else {
    aboutDialogEl.setAttribute("open", "");
  }
}
function closeAboutDialog() {
  if (!aboutDialogEl) return;
  if (typeof aboutDialogEl.close === "function") {
    aboutDialogEl.close();
  } else {
    aboutDialogEl.removeAttribute("open");
  }
}
aboutBtnEl?.addEventListener("click", openAboutDialog);
aboutLinkEl?.addEventListener("click", openAboutDialog);
aboutCloseEl?.addEventListener("click", closeAboutDialog);
aboutDialogEl?.addEventListener("click", (event) => {
  if (event.target === aboutDialogEl) closeAboutDialog();
});

let jaegerUiUrl = "/jaeger/";
const historyEntries = new Map();
// Tools whose tool-stale event has already flipped them (and any downstream
// peer) to a failed visual. The eventual tool-end — which arrives when the
// editor's RUN_TIMEOUT_MS aborts the in-flight call — must not clobber that.
const staleTools = new Set();
// Nodes/edges that have already been "discovered" by an inbound event and
// faded into the diagram. The diagram grows over time as the editor
// observes peers being called; everything starts hidden.
const revealedNodes = new Set();
const revealedEdges = new Set();
const TRANSITIVE_REVEAL_DELAY_MS = 250;
// Pending staggered child-node reveals, keyed by tool name. We cancel
// these the moment tool-end arrives so the result-application code can
// own the child's status without being clobbered by a late timer.
const pendingChildReveals = new Map();
// Flipped true the moment any tool fails (or goes stale) during the run.
// Keeps the editor node in its propagated-error state even after the
// workflow completes, so the chain origin → propagator → editor stays
// visible end-to-end. Reset on each request-start.
let runHadToolError = false;
// Set when a leaf peer's error span arrives via the sidecar's /recv
// fan-out — the verbatim error message from the peer that originated the
// failure. Used to override the editor/fact-checker cards' generic
// JSON-RPC message so OTel-delivered detail "wins" over the wrapped
// message. Stays null in broken-path because no leaf span lands.
let leafErrorMessage = null;
// Number of in-flight Claude calls (tracked via the SSE span-start/span-end
// events we publish from the editor's `claude.messages.create` spans). Used
// to drive the editor's "writing report…" activity indicator so the user
// can see the editor is still working even after the chain failed.
let claudeActiveCount = 0;
// Per-turn streaming buffer for Claude's text output. Each turn resets the
// buffer; the result panel shows whatever Claude is currently composing.
let streamingTurn = -1;
let streamingBuffer = "";

// Tools called directly by the editor map to mesh peers; each direct peer in
// turn fans out to a transitive peer. We use that mapping to drive the
// visual: when the editor's tool-end carries the upstream MCP result, we can
// also populate the transitive child node with what came back from it.
const TOOL_TO_NODE = {
  research: "researcher",
  fact_check: "fact-checker",
};
const NODE_TO_CHILD = {
  researcher: "web-search",
  "fact-checker": "citation-db",
};
const NODE_TO_PARENT = Object.fromEntries(
  Object.entries(NODE_TO_CHILD).map(([p, c]) => [c, p]),
);
// Mesh-panel nodes the frontend knows how to render. Used to filter the
// span-driven reveal so a stray span with an unrelated mcp.service value
// (e.g. an internal sub-step) doesn't try to reveal a non-existent node.
const KNOWN_NODES = new Set([
  "editor",
  "researcher",
  "fact-checker",
  "web-search",
  "citation-db",
]);
// Leaf peers — the deepest hops in this demo's mesh. When one of them
// reports an error span via the sidecar's /recv fan-out, we walk back
// up the chain and replace the upstream peers' (and editor's) generic
// JSON-RPC error with the rich message that came home over OTel. With
// the sidecar disabled no leaf span arrives, so the generic message wins.
const LEAF_TO_CHAIN = {
  "citation-db": ["fact-checker", "editor"],
  "web-search": ["researcher", "editor"],
};
// Flat set of every node that appears as an ancestor in any leaf chain —
// used to recognise "this peer's own span just landed and would otherwise
// clobber the rich leaf message we already propagated to it."
const LEAF_CHAIN_ANCESTORS = new Set(
  Object.values(LEAF_TO_CHAIN).flat(),
);

const events = new EventSource("/events");

events.addEventListener("message", (msg) => {
  let event;
  try {
    event = JSON.parse(msg.data);
  } catch {
    return;
  }
  if (event.type === "hello") {
    if (event.peer_id) {
      peerEl.textContent = event.peer_id.slice(0, 12) + "…";
      peerEl.title = event.peer_id;
    }
    if (event.jaeger_ui_url) {
      jaegerUiUrl = event.jaeger_ui_url.replace(/\/+$/, "") + "/";
      for (const a of jaegerLinkEls) a.href = jaegerUiUrl;
    }
    // First node we know about: the originator. Everything else fades in
    // as we observe it being called.
    revealNode("editor");
    return;
  }
  if (event.type === "history") {
    replayHistory(event.entries ?? []);
    return;
  }
  if (event.type === "request-start") {
    staleTools.clear();
    for (const handle of pendingChildReveals.values()) clearTimeout(handle);
    pendingChildReveals.clear();
    runHadToolError = false;
    leafErrorMessage = null;
    claudeActiveCount = 0;
    streamingTurn = -1;
    streamingBuffer = "";
    resultEl.classList.remove("streaming");
    resultEl.hidden = true;
    resultEl.textContent = "";
    setEditorActivity(null);
    resetMesh();
    // Re-grow the network from scratch on each run, so the demo shows the
    // diagram constructing itself as logs come in. The editor stays as the
    // anchor since it's the originator.
    hideAllExceptEditor();
    setNodeStatus("editor", "running", { traceId: event.traceId });
    upsertHistoryEntry({
      traceId: event.traceId,
      prompt: event.prompt,
      startedAt: event.startedAt ?? event.ts,
      status: "running",
    });
    appendEvent(event);
    return;
  }
  if (event.type === "tool-start") {
    const node = TOOL_TO_NODE[event.tool];
    if (node) {
      revealNode(node);
      revealEdge(`editor-${node}`);
      setEdgeActive(`editor-${node}`, true);
      setNodeStatus(node, "running", { peerId: event.peerId });
      // Downstream peers (web-search / citation-db) are revealed only when
      // their spans actually arrive via the sidecar's /recv fan-out. With
      // the sidecar disabled, no span ever lands, so those cards stay dark
      // — that's the whole point of the broken-path demo.
    }
  } else if (event.type === "tool-stale") {
    staleTools.add(event.tool);
    cancelPendingChildReveal(event.tool);
    runHadToolError = true;
    refreshEditorActivity();
    const node = TOOL_TO_NODE[event.tool];
    if (node) {
      setEdgeActive(`editor-${node}`, false);
      // We can't claim a downstream timeout from a peer the editor never
      // saw a span from — that would be a JSON-RPC inference, not a fact.
      // Just mark the directly-called peer and editor as failed.
      const editorMsg = "no response";
      setNodeStatus(node, "error", { message: editorMsg });
      setNodeStatus("editor", "error", { message: editorMsg });
    }
  } else if (event.type === "tool-end") {
    cancelPendingChildReveal(event.tool);
    const node = TOOL_TO_NODE[event.tool];
    if (node) {
      setEdgeActive(`editor-${node}`, false);
      if (staleTools.has(event.tool)) {
        // Already flipped by tool-stale; preserve that visual.
      } else if (event.ok) {
        // applyToolResult writes the rich payload (titles, verdicts) onto
        // both the directly-called node and its child. The child stays
        // invisible until its own span event reveals it — so in broken-path
        // the DOM is populated but never displayed. In fixed-path the span
        // arrives via /recv → callback and the rich content "wakes up".
        applyToolResult(node, event.result);
      } else {
        runHadToolError = true;
        refreshEditorActivity();
        // Prefer the rich message OTel surfaced from the leaf peer if it
        // already arrived; fall back to the wrapped JSON-RPC message.
        const message =
          leafErrorMessage ?? cleanErrorMessage(event.message ?? "error");
        setNodeStatus(node, "error", { message });
        setNodeStatus("editor", "error", { message });
      }
    }
  } else if (event.type === "result" && event.traceId) {
    // Only flip the editor green if no tool failed during this run; if the
    // chain propagated an error up to the editor, leave that visual in
    // place even after Claude composes its final answer.
    if (!runHadToolError) setNodeStatus("editor", "ok");
    claudeActiveCount = 0;
    setEditorActivity(null);
    resultEl.classList.remove("streaming");
    upsertHistoryEntry({
      traceId: event.traceId,
      status: "ok",
      text: event.text,
      endedAt: event.ts,
    });
  } else if (event.type === "error" && event.traceId) {
    const status = event.timeout ? "timeout" : "error";
    setNodeStatus("editor", status, { message: event.message });
    claudeActiveCount = 0;
    setEditorActivity(null);
    resultEl.classList.remove("streaming");
    upsertHistoryEntry({
      traceId: event.traceId,
      status,
      error: event.message,
      endedAt: event.ts,
    });
  } else if (event.type === "trace-ready" && event.traceId) {
    upsertHistoryEntry({ traceId: event.traceId, traceReady: true });
  } else if (event.type === "claude-stream-start") {
    // New turn: keep prior turns in the panel; just add a blank-line
    // separator so the chain of reasoning reads top-to-bottom without
    // earlier text being overwritten.
    if (streamingBuffer.length > 0 && event.turn !== streamingTurn) {
      streamingBuffer += "\n\n";
    }
    streamingTurn = event.turn ?? -1;
    resultEl.hidden = false;
    resultEl.textContent = streamingBuffer;
    resultEl.classList.add("streaming");
  } else if (event.type === "claude-text-delta") {
    if (event.turn !== streamingTurn) {
      // Edge case: delta arrived before stream-start (or out of order).
      // Apply the same separator rule so we never blow away prior text.
      if (streamingBuffer.length > 0) streamingBuffer += "\n\n";
      streamingTurn = event.turn ?? -1;
    }
    streamingBuffer += event.text ?? "";
    resultEl.hidden = false;
    resultEl.classList.add("streaming");
    resultEl.textContent = streamingBuffer;
  } else if (event.type === "claude-stream-end") {
    resultEl.classList.remove("streaming");
  } else if (event.type === "span-start" || event.type === "span-end") {
    // The editor publishes `claude.messages.create` spans for each LLM
    // round-trip (carries `gen_ai.system=anthropic` in attributes). Use them
    // to drive a live "writing report…" indicator on the editor node so the
    // viewer can see Claude is still composing even after the chain
    // propagated an error.
    const attrs = event.span?.attributes ?? {};
    if (attrs["gen_ai.system"]) {
      if (event.type === "span-start") claudeActiveCount += 1;
      else claudeActiveCount = Math.max(0, claudeActiveCount - 1);
      refreshEditorActivity();
    }
    // Reveal the mesh node corresponding to this span. Spans created by the
    // editor's own SDK (mcp.service for the directly-called peer) and spans
    // arriving via the sidecar's /recv fan-out (peer.name for downstream
    // peers) both flow through here. Without the sidecar, no /recv-sourced
    // spans land — so web-search and citation-db never get revealed.
    const peerName = attrs["mcp.service"] ?? attrs["peer.name"];
    if (peerName && KNOWN_NODES.has(peerName)) {
      revealNode(peerName);
      const parent = NODE_TO_PARENT[peerName];
      if (parent) revealEdge(`${parent}-${peerName}`);
      else if (peerName !== "editor") revealEdge(`editor-${peerName}`);
      // Surface error status from the inbound span so the originating peer
      // (e.g. citation-db) carries the failure visibly, not just its parent.
      if (event.type === "span-end" && event.span?.statusCode === 2) {
        const msg = cleanErrorMessage(
          event.span.statusMessage ?? "error",
        );
        const chain = LEAF_TO_CHAIN[peerName];
        if (chain) {
          // Leaf peer (web-search / citation-db): this is the root cause.
          // Stamp it on the leaf and propagate up through every ancestor
          // so the chain editor → propagator → leaf all show the same
          // OTel-delivered message.
          leafErrorMessage = msg;
          setNodeStatus(peerName, "error", { message: msg });
          for (const ancestor of chain) {
            setNodeStatus(ancestor, "error", { message: msg });
          }
        } else if (
          leafErrorMessage &&
          LEAF_CHAIN_ANCESTORS.has(peerName)
        ) {
          // Intermediate peer's own span landed (e.g. fact-checker's wrap
          // of citation-db's error). A leaf already gave us the root cause
          // upstream — don't let the wrap clobber it.
          setNodeStatus(peerName, "error", { message: leafErrorMessage });
        } else {
          setNodeStatus(peerName, "error", { message: msg });
        }
      }
    }
  }
  appendEvent(event);
});

events.addEventListener("error", () => {
  // Browser auto-reconnects; nothing to do here.
});

// ---------- mesh visual ----------

function nodeEl(name) {
  return document.querySelector(`.node[data-node="${name}"]`);
}

function edgeEl(name) {
  return document.querySelector(`.edge[data-edge="${name}"]`);
}

function resetMesh() {
  for (const n of [
    "editor",
    "researcher",
    "fact-checker",
    "web-search",
    "citation-db",
  ]) {
    setNodeStatus(n, "idle");
  }
  for (const e of [
    "editor-researcher",
    "editor-fact-checker",
    "researcher-web-search",
    "fact-checker-citation-db",
  ]) {
    setEdgeActive(e, false);
  }
}

function revealNode(name) {
  if (revealedNodes.has(name)) return;
  const el = nodeEl(name);
  if (!el) return;
  // rAF lets the browser paint the hidden state first, so the transition
  // actually animates rather than snapping straight to revealed.
  requestAnimationFrame(() => el.classList.add("revealed"));
  revealedNodes.add(name);
}

function revealEdge(name) {
  if (revealedEdges.has(name)) return;
  const el = edgeEl(name);
  if (!el) return;
  requestAnimationFrame(() => el.classList.add("revealed"));
  revealedEdges.add(name);
}

function cancelPendingChildReveal(tool) {
  const handle = pendingChildReveals.get(tool);
  if (handle !== undefined) {
    clearTimeout(handle);
    pendingChildReveals.delete(tool);
  }
}

// Manage a small italic pulsing line under the editor's body — used as a
// "thinking…" / "writing report…" indicator while a Claude span is active.
// Kept separate from the .node-output (which holds the propagated error)
// so both can coexist when Claude is composing despite a downstream error.
function setEditorActivity(text) {
  const el = nodeEl("editor");
  const body = el?.querySelector(".node-body");
  if (!body) return;
  let activity = body.querySelector(".editor-activity");
  if (!text) {
    if (activity) activity.remove();
    return;
  }
  if (!activity) {
    activity = document.createElement("div");
    activity.className = "editor-activity";
    body.appendChild(activity);
  }
  activity.textContent = text;
}

function refreshEditorActivity() {
  if (claudeActiveCount <= 0) {
    setEditorActivity(null);
    return;
  }
  setEditorActivity(runHadToolError ? "writing report…" : "thinking…");
}

function hideAllExceptEditor() {
  for (const n of revealedNodes) {
    if (n === "editor") continue;
    nodeEl(n)?.classList.remove("revealed");
  }
  revealedNodes.clear();
  if (nodeEl("editor")) revealedNodes.add("editor");
  for (const e of revealedEdges) {
    edgeEl(e)?.classList.remove("revealed");
  }
  revealedEdges.clear();
}

function setNodeStatus(name, status, meta = {}) {
  const el = nodeEl(name);
  if (!el) return;
  el.classList.remove("idle", "running", "ok", "error", "timeout");
  el.classList.add(status);
  if (meta.peerId) el.title = `peer id: ${meta.peerId}`;
  const body = el.querySelector(".node-body");
  if (status === "running") {
    // The editor is the originator, not a callee — showing it as "calling…"
    // is misleading. Just rely on the running border + dot for it. For the
    // peer nodes we keep the placeholder so it's clear the call is in flight.
    if (name === "editor") {
      const old = body?.querySelector(".node-output");
      if (old) old.remove();
    } else if (body && !body.querySelector(".node-output")) {
      // Clear any prior output but keep the static summary line.
      const summary = body.querySelector(".node-summary");
      body.innerHTML = "";
      if (summary) body.appendChild(summary);
      const placeholder = document.createElement("div");
      placeholder.className = "node-output running";
      placeholder.textContent = "calling…";
      body.appendChild(placeholder);
    }
  }
  if (status === "idle") {
    const output = el.querySelector(".node-output");
    if (output) output.remove();
    const sub = el.querySelector(".node-sub");
    if (sub) sub.remove();
  }
  if (status === "error" || status === "timeout") {
    if (body) {
      const out = body.querySelector(".node-output") ?? document.createElement("div");
      out.className = "node-output " + status;
      out.textContent = meta.message ?? status;
      if (!out.parentNode) body.appendChild(out);
    }
  }
  if (status === "ok") {
    // Don't trample any output a previous applyToolResult call set up; only
    // clear the placeholder/error from earlier states. Add a sub note if
    // this node "forwarded" a downstream error.
    if (body) {
      const out = body.querySelector(".node-output");
      if (out && (out.classList.contains("running") || out.classList.contains("error") || out.classList.contains("timeout"))) {
        out.remove();
      }
      const existingSub = body.querySelector(".node-sub");
      if (existingSub) existingSub.remove();
      if (meta.sub) {
        const sub = document.createElement("div");
        sub.className = "node-sub";
        sub.textContent = meta.sub;
        body.appendChild(sub);
      }
    }
  }
}

function messageMentions(message, peerName) {
  if (!message || !peerName) return false;
  const m = message.toLowerCase();
  // Tolerate "citation-db" / "citation db" / "Citation-DB" etc.
  return m.includes(peerName.toLowerCase()) ||
    m.includes(peerName.toLowerCase().replace(/-/g, " "));
}

function cleanErrorMessage(msg) {
  if (!msg) return "error";
  // Strip nested "MCP error -32000: " prefixes the editor → fact-checker →
  // citation-db chain accumulates so the displayed message is readable.
  return msg.replace(/^(MCP error -?\d+:\s*)+/g, "").trim() || msg;
}

function setEdgeActive(name, active) {
  const el = edgeEl(name);
  if (!el) return;
  el.classList.toggle("active", !!active);
}

function applyToolResult(node, result) {
  if (node === "researcher") {
    const summary = result?.summary ?? "(no summary)";
    const sources = Array.isArray(result?.sources) ? result.sources : [];
    setNodeOutput("researcher", "ok", summary, {
      sub: `${sources.length} source${sources.length === 1 ? "" : "s"}`,
    });
    setNodeOutput(
      "web-search",
      "ok",
      sources.length === 0
        ? "no results"
        : sources
            .slice(0, 3)
            .map((s) => `• ${s.title}`)
            .join("\n"),
      { sub: hostList(sources.map((s) => s.url)) },
    );
  } else if (node === "fact-checker") {
    const status = result?.status ?? "(no verdict)";
    const rationale = result?.rationale ?? "";
    const sources = Array.isArray(result?.sources) ? result.sources : [];
    setNodeOutput("fact-checker", "ok", `${status} — ${rationale}`, {
      sub: `${sources.length} verdict${sources.length === 1 ? "" : "s"}`,
    });
    setNodeOutput(
      "citation-db",
      "ok",
      sources.length === 0
        ? "no verdicts"
        : sources
            .map((v) => `• ${v.domain}: ${v.reputability}`)
            .join("\n"),
      { sub: undefined },
    );
  }
}

function setNodeOutput(node, status, text, { sub } = {}) {
  const el = nodeEl(node);
  if (!el) return;
  el.classList.remove("idle", "running", "ok", "error");
  el.classList.add(status);
  const body = el.querySelector(".node-body");
  if (!body) return;
  const summary = body.querySelector(".node-summary");
  body.innerHTML = "";
  if (summary) body.appendChild(summary);
  const out = document.createElement("div");
  out.className = "node-output " + status;
  out.textContent = text;
  body.appendChild(out);
  if (sub) {
    const subEl = document.createElement("div");
    subEl.className = "node-sub";
    subEl.textContent = sub;
    body.appendChild(subEl);
  }
}

function hostList(urls) {
  const hosts = [];
  const seen = new Set();
  for (const u of urls) {
    try {
      const h = new URL(u).hostname;
      if (!seen.has(h)) {
        seen.add(h);
        hosts.push(h);
      }
    } catch {
      // ignore non-URLs
    }
  }
  return hosts.slice(0, 3).join(", ");
}

// ---------- raw event log ----------

function appendEvent(event) {
  const li = document.createElement("li");
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = formatTime(event.ts ?? Date.now());

  const k = document.createElement("span");
  k.className = "k";

  const body = document.createElement("span");
  body.className = "body";

  switch (event.type) {
    case "request-start":
      k.classList.add("start");
      k.textContent = "request ▶";
      body.textContent = (event.prompt ?? "").slice(0, 80);
      break;
    case "tool-start":
      k.classList.add("start");
      k.textContent = "tool ▶";
      body.append(
        peerBadge(event.peer, event.peerId),
        textNode(`${event.tool}(${formatInput(event.input)})`),
      );
      break;
    case "tool-end":
      k.classList.add(event.ok ? "end-ok" : "end-bad");
      k.textContent = event.ok ? "tool ✓" : "tool ✗";
      body.append(
        peerBadge(event.peer, event.peerId),
        textNode(
          event.ok
            ? event.tool
            : `${event.tool}: ${event.message ?? "error"}`,
        ),
      );
      break;
    case "tool-stale":
      k.classList.add("end-bad");
      k.textContent = "tool …";
      body.append(
        peerBadge(event.peer, event.peerId),
        textNode(
          `${event.tool}: no response after ${
            event.elapsedMs ? Math.round(event.elapsedMs / 1000) + "s" : "stale"
          }`,
        ),
      );
      break;
    case "span-start": {
      k.classList.add("start");
      k.textContent = "span ▶";
      const peer = spanPeer(event.span);
      if (peer) body.appendChild(peerBadge(peer.name, peer.id));
      body.appendChild(textNode(event.span?.name ?? "(unknown)"));
      break;
    }
    case "span-end": {
      const ok = event.span?.statusCode !== 2;
      k.classList.add(ok ? "end-ok" : "end-bad");
      k.textContent = ok ? "span ✓" : "span ✗";
      const dur = event.span?.durationMs?.toFixed?.(1) ?? "?";
      const peer = spanPeer(event.span);
      if (peer) body.appendChild(peerBadge(peer.name, peer.id));
      body.appendChild(
        textNode(`${event.span?.name ?? "(unknown)"} (${dur} ms)`),
      );
      break;
    }
    case "result":
      k.classList.add("end-ok");
      k.textContent = "result";
      body.textContent = "(see final answer)";
      break;
    case "error":
      k.classList.add("end-bad");
      k.textContent = "error";
      body.textContent = event.message ?? "unknown error";
      break;
    default:
      k.textContent = event.type;
      body.textContent = JSON.stringify(event);
  }

  li.append(t, k, body);
  eventsEl.prepend(li);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function spanPeer(span) {
  if (!span) return null;
  const attrs = span.attributes ?? {};
  const name = attrs["peer.name"] ?? attrs["mcp.service"];
  const id = attrs["peer.id"];
  if (!name && !id) return null;
  return { name: name ?? null, id: id ?? null };
}

function peerBadge(name, id) {
  const wrap = document.createElement("span");
  wrap.className = "peer-badge";
  wrap.title = id ? `${name ?? "peer"}\npeer id: ${id}` : name ?? "";
  if (name) {
    const n = document.createElement("span");
    n.className = "peer-name";
    n.textContent = "→ " + name;
    wrap.appendChild(n);
  }
  if (id) {
    const idEl = document.createElement("span");
    idEl.className = "peer-id";
    idEl.textContent = id.slice(0, 8) + "…";
    wrap.appendChild(idEl);
  }
  return wrap;
}

function textNode(text) {
  const span = document.createElement("span");
  span.className = "msg";
  span.textContent = text;
  return span;
}

function formatInput(input) {
  if (!input) return "";
  try {
    const s = JSON.stringify(input);
    return s.length > 80 ? s.slice(0, 77) + "..." : s;
  } catch {
    return String(input);
  }
}

// ---------- history ----------

function replayHistory(entries) {
  historyEntries.clear();
  historyEl.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "No requests yet.";
    historyEl.appendChild(empty);
    return;
  }
  for (const e of entries) renderHistoryEntry(e, { append: true });
}

function upsertHistoryEntry(patch) {
  if (!patch.traceId) return;
  const existing = historyEntries.get(patch.traceId);
  const merged = existing ? { ...existing, ...patch } : patch;
  renderHistoryEntry(merged, { append: false });
}

function renderHistoryEntry(entry, { append }) {
  const empty = historyEl.querySelector(".history-empty");
  if (empty) empty.remove();

  const existingLi = historyEntries.get(entry.traceId)?.el;
  const li = existingLi ?? document.createElement("li");
  li.className = "history-item " + (entry.status ?? "running");
  li.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "history-meta";

  const t = document.createElement("span");
  t.className = "t";
  t.textContent = formatTime(entry.startedAt ?? Date.now());
  meta.appendChild(t);

  const status = document.createElement("span");
  status.className = "history-status " + (entry.status ?? "running");
  status.textContent = statusLabel(entry);
  meta.appendChild(status);

  if (entry.startedAt && entry.endedAt) {
    const dur = document.createElement("span");
    dur.className = "history-duration";
    dur.textContent = formatDuration(entry.endedAt - entry.startedAt);
    meta.appendChild(dur);
  }

  const link = document.createElement("a");
  link.href = `${jaegerUiUrl}trace/${entry.traceId}`;
  link.target = "_blank";
  link.rel = "noopener";
  // The run is "complete" once status is no longer running. Until Jaeger
  // confirms the trace is queryable, dim the link and tag it as indexing
  // so users don't click into a 404. Server-side polling flips
  // entry.traceReady to true via a `trace-ready` SSE event.
  const runDone =
    entry.status === "ok" ||
    entry.status === "error" ||
    entry.status === "timeout";
  if (runDone && !entry.traceReady) {
    link.className = "history-trace pending";
    link.textContent = `trace ${entry.traceId.slice(0, 8)}… (indexing…)`;
    link.title = `Trace ${entry.traceId} is being indexed by Jaeger; click anyway if you want to retry.`;
  } else {
    link.className = "history-trace";
    link.textContent = `trace ${entry.traceId.slice(0, 8)}… →`;
    link.title = `Open trace ${entry.traceId} in Jaeger`;
  }
  meta.appendChild(link);

  li.appendChild(meta);

  const prompt = document.createElement("div");
  prompt.className = "history-prompt";
  prompt.textContent = truncate(entry.prompt ?? "", 200);
  li.appendChild(prompt);

  if ((entry.status === "error" || entry.status === "timeout") && entry.error) {
    const err = document.createElement("div");
    err.className = "history-error";
    err.textContent = entry.error;
    li.appendChild(err);
  }

  historyEntries.set(entry.traceId, { ...entry, el: li });

  if (!existingLi) {
    if (append) historyEl.appendChild(li);
    else historyEl.prepend(li);
  }
}

function statusLabel(entry) {
  if (entry.status === "ok") return "ok";
  if (entry.status === "error") return "error";
  if (entry.status === "timeout") return "timeout";
  return "running…";
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------- run button ----------

runBtn.addEventListener("click", async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    promptEl.focus();
    return;
  }
  runBtn.disabled = true;
  resultEl.hidden = true;
  resultEl.textContent = "";
  resultEl.classList.remove("streaming");
  rateWarnEl.hidden = true;
  rateWarnEl.textContent = "";
  try {
    const res = await fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status === 503) {
      rateWarnEl.hidden = false;
      rateWarnEl.textContent =
        json.error ?? `rate limited (HTTP ${res.status})`;
    } else if (res.status === 504 || json.timeout) {
      resultEl.hidden = false;
      resultEl.textContent = `timeout: ${json.error ?? "no response from editor"}`;
    } else if (!res.ok) {
      resultEl.hidden = false;
      resultEl.textContent = `error: ${json.error ?? res.statusText}`;
    } else {
      resultEl.hidden = false;
      // Prefer the streamed buffer if it has content — the /run JSON only
      // carries the *last* turn's text, while the buffer holds the full
      // chain of reasoning that the viewer just watched type out.
      if (!streamingBuffer) {
        resultEl.textContent = json.text ?? "(no text)";
      }
    }
  } catch (err) {
    resultEl.hidden = false;
    resultEl.textContent = `request failed: ${err}`;
  } finally {
    runBtn.disabled = false;
  }
});
