const promptEl = document.getElementById("prompt");
const runBtn = document.getElementById("run");
const resultEl = document.getElementById("result");
const eventsEl = document.getElementById("events");
const peerEl = document.getElementById("peer-id");
const historyEl = document.getElementById("history");
const rateWarnEl = document.getElementById("rate-warn");
const jaegerLinkEls = [
  document.getElementById("jaeger-link"),
  document.getElementById("jaeger-link-2"),
].filter(Boolean);

let jaegerUiUrl = "/jaeger/";
const historyEntries = new Map();

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
    return;
  }
  if (event.type === "history") {
    replayHistory(event.entries ?? []);
    return;
  }
  if (event.type === "request-start") {
    resetMesh();
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
      setEdgeActive(`editor-${node}`, true);
      setNodeStatus(node, "running", { peerId: event.peerId });
      const child = NODE_TO_CHILD[node];
      if (child) {
        setEdgeActive(`${node}-${child}`, true);
        setNodeStatus(child, "running");
      }
    }
  } else if (event.type === "tool-end") {
    const node = TOOL_TO_NODE[event.tool];
    if (node) {
      setEdgeActive(`editor-${node}`, false);
      const child = NODE_TO_CHILD[node];
      if (child) setEdgeActive(`${node}-${child}`, false);
      if (event.ok) {
        applyToolResult(node, event.result);
      } else {
        setNodeStatus(node, "error", { message: event.message ?? "error" });
        if (child) setNodeStatus(child, "idle");
      }
    }
  } else if (event.type === "result" && event.traceId) {
    setNodeStatus("editor", "ok");
    upsertHistoryEntry({
      traceId: event.traceId,
      status: "ok",
      text: event.text,
      endedAt: event.ts,
    });
  } else if (event.type === "error" && event.traceId) {
    setNodeStatus("editor", "error", { message: event.message });
    upsertHistoryEntry({
      traceId: event.traceId,
      status: "error",
      error: event.message,
      endedAt: event.ts,
    });
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

function setNodeStatus(name, status, meta = {}) {
  const el = nodeEl(name);
  if (!el) return;
  el.classList.remove("idle", "running", "ok", "error");
  el.classList.add(status);
  if (meta.peerId) el.title = `peer id: ${meta.peerId}`;
  if (status === "running") {
    const body = el.querySelector(".node-body");
    if (body && !body.querySelector(".node-output")) {
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
  }
  if (status === "error") {
    const body = el.querySelector(".node-body");
    if (body) {
      const out = body.querySelector(".node-output") ?? document.createElement("div");
      out.className = "node-output error";
      out.textContent = meta.message ?? "error";
      if (!out.parentNode) body.appendChild(out);
    }
  }
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
  link.className = "history-trace";
  link.href = `${jaegerUiUrl}trace/${entry.traceId}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `trace ${entry.traceId.slice(0, 8)}… →`;
  link.title = `Open trace ${entry.traceId} in Jaeger`;
  meta.appendChild(link);

  li.appendChild(meta);

  const prompt = document.createElement("div");
  prompt.className = "history-prompt";
  prompt.textContent = truncate(entry.prompt ?? "", 200);
  li.appendChild(prompt);

  if (entry.status === "error" && entry.error) {
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
    } else if (!res.ok) {
      resultEl.hidden = false;
      resultEl.textContent = `error: ${json.error ?? res.statusText}`;
    } else {
      resultEl.hidden = false;
      resultEl.textContent = json.text ?? "(no text)";
    }
  } catch (err) {
    resultEl.hidden = false;
    resultEl.textContent = `request failed: ${err}`;
  } finally {
    runBtn.disabled = false;
  }
});
