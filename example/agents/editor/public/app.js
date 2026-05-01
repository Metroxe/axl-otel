const promptEl = document.getElementById("prompt");
const runBtn = document.getElementById("run");
const resultEl = document.getElementById("result");
const eventsEl = document.getElementById("events");
const peerEl = document.getElementById("peer-id");
const historyEl = document.getElementById("history");

let jaegerUiUrl = "http://localhost:16686";
const historyEntries = new Map();

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
      jaegerUiUrl = event.jaeger_ui_url.replace(/\/+$/, "");
    }
    return;
  }
  if (event.type === "history") {
    replayHistory(event.entries ?? []);
    return;
  }
  if (event.type === "request-start") {
    upsertHistoryEntry({
      traceId: event.traceId,
      prompt: event.prompt,
      startedAt: event.startedAt ?? event.ts,
      status: "running",
    });
    return;
  }
  if (event.type === "result" && event.traceId) {
    upsertHistoryEntry({
      traceId: event.traceId,
      status: "ok",
      text: event.text,
      endedAt: event.ts,
    });
  } else if (event.type === "error" && event.traceId) {
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
      body.textContent = "(see right panel)";
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

// Pulls a peer name + peer id off a span event. tool-start/end carry the
// fields directly; span-* events expose them via attributes from the
// editor's custom SpanProcessor.
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
  // Server sends newest-first; render in the same order.
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
  link.href = `${jaegerUiUrl}/trace/${entry.traceId}`;
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

runBtn.addEventListener("click", async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    promptEl.focus();
    return;
  }
  runBtn.disabled = true;
  resultEl.hidden = true;
  resultEl.textContent = "";
  try {
    const res = await fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const json = await res.json();
    resultEl.hidden = false;
    if (!res.ok) {
      resultEl.textContent = `error: ${json.error ?? res.statusText}`;
    } else {
      resultEl.textContent = json.text ?? "(no text)";
    }
  } catch (err) {
    resultEl.hidden = false;
    resultEl.textContent = `request failed: ${err}`;
  } finally {
    runBtn.disabled = false;
  }
});
