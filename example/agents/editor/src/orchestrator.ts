import Anthropic from "@anthropic-ai/sdk";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import { callMcp, readPeerId } from "./mcp-client.ts";
import type { EventBus } from "./sse.ts";

const MODEL = "claude-sonnet-4-6";

// System prompt is static across runs and a perfect fit for prompt caching;
// the tools list is also stable, so cache_control on the last tool covers
// the whole tools block.
const SYSTEM_PROMPT = `You are a concise editor running on top of a peer-to-peer agent mesh.
You receive a user prompt and have two MCP-backed tools at your disposal:

- research(topic, depth?): pulls source material from the upstream Web-Search agent
  and returns a short summary plus a list of sources.
- fact_check(claim, sources): asks the Fact-Checker agent to assess the reputability
  of the supporting sources for a specific claim.

Your job is to:
1. Decide which tools to call (you may call them multiple times in any order).
2. Use research first if you don't already have sources; then fact_check the
   strongest claim you want to make.
3. Compose a brief, grounded final answer (2-4 sentences) that cites the
   most reputable sources by domain.

Never invent URLs. Only cite URLs returned by the tools. If a claim is
"unsupported" by fact_check, acknowledge that explicitly.`;

const TOOLS = [
  {
    name: "research",
    description:
      "Research a topic via the mesh's Web-Search agent. Returns a summary and a list of sources.",
    input_schema: {
      type: "object" as const,
      properties: {
        topic: { type: "string", description: "topic to research" },
        depth: {
          type: "integer",
          description: "max sources to consult (default 3, max 6)",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "fact_check",
    description:
      "Verify a claim against a list of source URLs by asking the mesh's Fact-Checker agent.",
    input_schema: {
      type: "object" as const,
      properties: {
        claim: { type: "string", description: "the claim being verified" },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "URLs supporting the claim",
        },
      },
      required: ["claim", "sources"],
    },
    cache_control: { type: "ephemeral" as const },
  },
];

export type OrchestrateOptions = {
  prompt: string;
  ourPeerId: string;
  axlUrl: string;
  tracer: Tracer;
  bus: EventBus;
  anthropic: Anthropic;
  onWorkflowStart?: (traceId: string) => void;
  signal?: AbortSignal;
  toolStaleMs?: number;
};

export type OrchestrateResult = {
  text: string;
  traceId: string;
};

export async function orchestrate(
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const { prompt, ourPeerId, axlUrl, tracer, bus, anthropic } = opts;

  // Set the originator peer ID as a baggage entry. Every span emitted under
  // this context inherits the entry via BaggageSpanProcessor; the OTel
  // sidecar reads it and routes the span to the correct local Jaeger.
  const baggage = propagation
    .createBaggage()
    .setEntry("originator_peer_id", { value: ourPeerId });
  const baggageCtx = propagation.setBaggage(context.active(), baggage);

  return await context.with(baggageCtx, async () => {
    const workflowSpan = tracer.startSpan("editor.workflow", {
      kind: SpanKind.INTERNAL,
      attributes: { "editor.prompt.length": prompt.length },
    });
    const traceId = workflowSpan.spanContext().traceId;
    opts.onWorkflowStart?.(traceId);

    try {
      return await context.with(
        trace.setSpan(context.active(), workflowSpan),
        async () => {
          const messages: Anthropic.MessageParam[] = [
            { role: "user", content: prompt },
          ];

          let response = await callClaude({
            anthropic,
            tracer,
            bus,
            messages,
            turn: 0,
            signal: opts.signal,
          });

          let turn = 0;
          while (response.stop_reason === "tool_use" && turn < 10) {
            turn += 1;
            const toolUses = response.content.filter(
              (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
            );
            const toolResults: Anthropic.ToolResultBlockParam[] =
              await Promise.all(
                toolUses.map(async (tu) => {
                  const resultText = await runEditorTool(
                    tu.name,
                    tu.input as Record<string, unknown>,
                    {
                      axlUrl,
                      tracer,
                      bus,
                      signal: opts.signal,
                      toolStaleMs: opts.toolStaleMs,
                    },
                  );
                  return {
                    type: "tool_result",
                    tool_use_id: tu.id,
                    content: resultText,
                  };
                }),
              );
            messages.push({ role: "assistant", content: response.content });
            messages.push({ role: "user", content: toolResults });

            response = await callClaude({
              anthropic,
              tracer,
              bus,
              messages,
              turn,
              signal: opts.signal,
            });
          }

          const finalText = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();

          bus.publish({ type: "result", text: finalText, traceId });
          return { text: finalText, traceId };
        },
      );
    } catch (err) {
      const aborted = opts.signal?.aborted === true;
      const reason = opts.signal?.reason;
      const message = aborted
        ? reason instanceof Error
          ? reason.message
          : String(reason ?? "timed out")
        : err instanceof Error
          ? err.message
          : String(err);
      workflowSpan.setStatus({ code: SpanStatusCode.ERROR, message });
      bus.publish({
        type: "error",
        message,
        traceId,
        ...(aborted ? { timeout: true } : {}),
      });
      throw err;
    } finally {
      workflowSpan.end();
    }
  });
}

async function runEditorTool(
  name: string,
  input: Record<string, unknown>,
  ctx: {
    axlUrl: string;
    tracer: Tracer;
    bus: EventBus;
    signal?: AbortSignal;
    toolStaleMs?: number;
  },
): Promise<string> {
  // Resolve which mesh peer this tool maps to up-front so the SSE event
  // can name the destination clearly.
  const route = TOOL_ROUTES[name];
  if (!route) {
    const message = `unknown tool: ${name}`;
    ctx.bus.publish({ type: "tool-end", tool: name, ok: false, message });
    return JSON.stringify({ error: message });
  }

  const peerId = readPeerId(route.peer);
  const span = ctx.tracer.startSpan(`editor.tool.${name}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      "editor.tool": name,
      "peer.name": route.peer,
      "peer.id": peerId,
    },
  });

  ctx.bus.publish({
    type: "tool-start",
    tool: name,
    peer: route.peer,
    peerId,
    input,
  });

  // If the call doesn't return within `toolStaleMs`, surface a `tool-stale`
  // event so the UI can flip the called peer (and its transitive child) to
  // a "no response" state. The editor itself stays in the loop until the
  // run-level abort signal fires — that's the demo: downstream visibly
  // gives up while the editor keeps waiting.
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const staleMs = ctx.toolStaleMs;
  if (staleMs && staleMs > 0) {
    staleTimer = setTimeout(() => {
      ctx.bus.publish({
        type: "tool-stale",
        tool: name,
        peer: route.peer,
        peerId,
        elapsedMs: staleMs,
      });
    }, staleMs);
  }

  try {
    return await context.with(
      trace.setSpan(context.active(), span),
      async () => {
        const result = await callMcp({
          axlUrl: ctx.axlUrl,
          peerId,
          service: route.service,
          tool: route.tool,
          args: input,
          tracer: ctx.tracer,
          signal: ctx.signal,
        });
        ctx.bus.publish({
          type: "tool-end",
          tool: name,
          peer: route.peer,
          peerId,
          ok: true,
          result,
        });
        return JSON.stringify(result);
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    ctx.bus.publish({
      type: "tool-end",
      tool: name,
      peer: route.peer,
      peerId,
      ok: false,
      message,
    });
    return JSON.stringify({ error: message });
  } finally {
    if (staleTimer) clearTimeout(staleTimer);
    span.end();
  }
}

const TOOL_ROUTES: Record<string, { peer: string; service: string; tool: string }> = {
  research: { peer: "researcher", service: "researcher", tool: "research" },
  fact_check: { peer: "fact-checker", service: "fact-checker", tool: "check" },
};

// Wraps each Anthropic call in a `claude.messages.create` span. Without
// this, Jaeger shows a multi-second gap of "nothing happening" between
// tool calls; with it, the LLM time becomes a first-class span with
// model, token, and cache-hit attributes — much more useful for the demo.
async function callClaude(opts: {
  anthropic: Anthropic;
  tracer: Tracer;
  bus: EventBus;
  messages: Anthropic.MessageParam[];
  turn: number;
  signal?: AbortSignal;
}): Promise<Anthropic.Message> {
  const span = opts.tracer.startSpan("claude.messages.create", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": MODEL,
      "gen_ai.request.max_tokens": 2048,
      "gen_ai.request.streaming": true,
      "editor.turn": opts.turn,
      "editor.messages.count": opts.messages.length,
    },
  });
  try {
    return await context.with(
      trace.setSpan(context.active(), span),
      async () => {
        // Stream the response so the UI can show Claude's text as it's
        // being composed. Each text delta is published on the bus and
        // forwarded over SSE; the call returns the assembled final
        // message so the rest of the orchestration stays unchanged.
        const stream = opts.anthropic.messages.stream(
          {
            model: MODEL,
            max_tokens: 2048,
            system: [
              {
                type: "text",
                text: SYSTEM_PROMPT,
                cache_control: { type: "ephemeral" },
              },
            ],
            tools: TOOLS,
            messages: opts.messages,
          },
          { signal: opts.signal },
        );

        opts.bus.publish({
          type: "claude-stream-start",
          turn: opts.turn,
        });

        stream.on("text", (textDelta: string) => {
          opts.bus.publish({
            type: "claude-text-delta",
            turn: opts.turn,
            text: textDelta,
          });
        });

        const response = await stream.finalMessage();

        opts.bus.publish({
          type: "claude-stream-end",
          turn: opts.turn,
          stopReason: response.stop_reason ?? null,
        });
        span.setAttribute(
          "gen_ai.response.model",
          response.model ?? MODEL,
        );
        span.setAttribute(
          "gen_ai.response.id",
          response.id ?? "",
        );
        span.setAttribute(
          "gen_ai.response.stop_reason",
          response.stop_reason ?? "",
        );
        const u = response.usage;
        if (u) {
          span.setAttribute("gen_ai.usage.input_tokens", u.input_tokens);
          span.setAttribute("gen_ai.usage.output_tokens", u.output_tokens);
          if (u.cache_creation_input_tokens != null) {
            span.setAttribute(
              "gen_ai.usage.cache_creation_input_tokens",
              u.cache_creation_input_tokens,
            );
          }
          if (u.cache_read_input_tokens != null) {
            span.setAttribute(
              "gen_ai.usage.cache_read_input_tokens",
              u.cache_read_input_tokens,
            );
          }
        }
        const toolUseCount = response.content.filter(
          (b) => b.type === "tool_use",
        ).length;
        span.setAttribute("editor.tool_use.count", toolUseCount);
        return response;
      },
    );
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    opts.bus.publish({
      type: "claude-stream-end",
      turn: opts.turn,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}
