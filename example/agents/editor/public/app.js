const promptEl = document.getElementById("prompt");
const runBtn = document.getElementById("run");
const resultEl = document.getElementById("result");
const eventsEl = document.getElementById("events");
const peerEl = document.getElementById("peer-id");

const events = new EventSource("/events");

events.addEventListener("message", (msg) => {
  let event;
  try {
    event = JSON.parse(msg.data);
  } catch {
    return;
  }
  if (event.type === "hello" && event.peer_id) {
    peerEl.textContent = event.peer_id.slice(0, 12) + "…";
    peerEl.title = event.peer_id;
    return;
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
      body.textContent = `${event.tool}(${formatInput(event.input)})`;
      break;
    case "tool-end":
      k.classList.add(event.ok ? "end-ok" : "end-bad");
      k.textContent = event.ok ? "tool ✓" : "tool ✗";
      body.textContent = event.ok
        ? event.tool
        : `${event.tool}: ${event.message ?? "error"}`;
      break;
    case "span-start":
      k.classList.add("start");
      k.textContent = "span ▶";
      body.textContent = event.span?.name ?? "(unknown)";
      break;
    case "span-end": {
      const ok = event.span?.statusCode !== 2;
      k.classList.add(ok ? "end-ok" : "end-bad");
      k.textContent = ok ? "span ✓" : "span ✗";
      const dur = event.span?.durationMs?.toFixed?.(1) ?? "?";
      body.textContent = `${event.span?.name ?? "(unknown)"} (${dur} ms)`;
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

function formatInput(input) {
  if (!input) return "";
  try {
    const s = JSON.stringify(input);
    return s.length > 80 ? s.slice(0, 77) + "..." : s;
  } catch {
    return String(input);
  }
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
