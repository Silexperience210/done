import { createFileRoute } from "@tanstack/react-router";
import {
  isFrench,
  MODELS,
  systemPrompt,
  TOOL_DEFS,
  wantsTools,
  type ModelId,
} from "@/lib/edge0";
import { resolveLocalTurn, type LocalTurn } from "@/lib/local-apps";
import { executeTool } from "@/lib/tools.server";

const MAX_MESSAGES = 8;
const MAX_CHARS = 1800;
const MAX_TURNS = 2;
const FAST_MODELS = ["grok-4-fast-non-reasoning", "grok-4.1-fast", "grok-4.5"] as const;

let cachedUpstream: string | null = null;

type InMsg = { role?: string; content?: string };

type ApiMsg =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls: ToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type XDelta = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.XAI_API_KEY;
        if (!apiKey) {
          return Response.json({ error: "AI is not available" }, { status: 503 });
        }

        let parsed: { model?: string; messages?: InMsg[] };
        try {
          parsed = (await request.json()) as { model?: string; messages?: InMsg[] };
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }

        const modelId: ModelId = parsed.model === "8b" ? "8b" : "35b";
        const incoming = Array.isArray(parsed.messages) ? parsed.messages : [];
        const history = incoming
          .filter(
            (m): m is { role: "user" | "assistant"; content: string } =>
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.trim().length > 0,
          )
          .slice(-MAX_MESSAGES)
          .map((m) => ({
            role: m.role,
            content: m.content.slice(0, MAX_CHARS),
          }));

        if (history.length === 0) {
          return Response.json({ error: "No messages" }, { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };
            try {
              await runAgent({ apiKey, modelId, history, send });
              send({ type: "done" });
            } catch {
              const lastUser =
                [...history].reverse().find((m) => m.role === "user")?.content ?? "";
              emitLocalTurn(resolveLocalTurn(lastUser, true), send);
              send({ type: "done" });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});

async function runAgent({
  apiKey,
  modelId,
  history,
  send,
}: {
  apiKey: string;
  modelId: ModelId;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  send: (obj: unknown) => void;
}) {
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const local = resolveLocalTurn(lastUser);
  if (local.kind !== "chat") {
    emitLocalTurn(local, send);
    return;
  }

  const useTools = wantsTools(lastUser);
  const tools = useTools ? pickTools(lastUser) : undefined;
  const french = isFrench(lastUser);

  const messages: ApiMsg[] = [
    { role: "system", content: systemPrompt(modelId) },
    ...history,
  ];
  const profile = MODELS[modelId];
  const maxTokens = useTools ? (modelId === "8b" ? 520 : 700) : modelId === "8b" ? 220 : 320;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await completeTurn({
      apiKey,
      messages,
      send,
      tools: turn === 0 ? tools : undefined,
      maxTokens: turn === 0 ? maxTokens : 160,
    });

    if (result.toolCalls.length === 0) {
      if (!result.streamedContent && result.content) {
        send({ type: "token", text: result.content });
      }
      return;
    }

    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    });

    let wroteApp = false;
    let jsSummary: string | null = null;

    await Promise.all(
      result.toolCalls.map(async (call) => {
        send({
          type: "tool",
          id: call.id,
          name: call.function.name,
          status: "start",
          args: safeParse(call.function.arguments),
        });
        const executed = executeTool(call.function.name, call.function.arguments, {
          model: modelId,
          memoryGb: profile.peakGb * 0.82,
          tokPerSec: profile.tokMin,
        });
        if (executed.app) {
          wroteApp = true;
          send({ type: "app", ...executed.app });
        }
        if (call.function.name === "run_js") jsSummary = formatJs(executed.result, french);
        send({
          type: "tool",
          id: call.id,
          name: call.function.name,
          status: "done",
          result: executed.result.slice(0, 1500),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: executed.result,
        });
      }),
    );

    if (result.streamedContent) return;

    if (wroteApp) {
      send({
        type: "token",
        text: french
          ? "C’est dans le studio. Run pour lancer, Code pour lire."
          : "It’s in the studio. Run to play, Code to read.",
      });
      return;
    }
    if (jsSummary) {
      send({ type: "token", text: jsSummary });
      return;
    }
    }
  } catch {
    emitLocalTurn(resolveLocalTurn(lastUser, true), send);
  }
}

function emitLocalTurn(turn: LocalTurn, send: (obj: unknown) => void) {
  if (turn.kind === "app") {
    const app = turn.app;
    send({ type: "thinking", text: "Prerouter → write_app · studio\n" });
    send({
      type: "tool",
      id: "local-app",
      name: "write_app",
      status: "start",
      args: { title: app.title },
    });
    send({ type: "app", title: app.title, html: app.html });
    send({
      type: "tool",
      id: "local-app",
      name: "write_app",
      status: "done",
      result: app.title,
    });
    send({ type: "token", text: app.note });
    return;
  }
  if (turn.kind === "calc") {
    send({ type: "thinking", text: "Prerouter → run_js · sandbox\n" });
    send({
      type: "tool",
      id: "local-js",
      name: "run_js",
      status: "start",
      args: { code: turn.expression },
    });
    send({
      type: "tool",
      id: "local-js",
      name: "run_js",
      status: "done",
      result: turn.value,
    });
    send({ type: "token", text: turn.note });
    return;
  }
  send({ type: "token", text: turn.content });
}

function pickTools(text: string) {
  const calc = /calcul|puissance|compute|math|run_js|outil|algorithm/i.test(text);
  const app = /game|html|playable|scene|page|\bapp\b|canvas|widget|snake|particule|particle|jeu|demo|démo|code/i.test(
    text,
  );
  const tel = /telemetry|working set|\bram\b|expert|tok\/s/i.test(text);
  return TOOL_DEFS.filter((t) => {
    const n = t.function.name;
    if (n === "write_app") return app || (!calc && !tel);
    if (n === "run_js") return calc || (!app && !tel);
    if (n === "device_telemetry") return tel;
    return false;
  });
}

function formatJs(raw: string, french: boolean) {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      result?: string | null;
      logs?: string[];
      error?: string;
    };
    if (parsed.error) return parsed.error;
    const bits = [parsed.result, ...(parsed.logs ?? [])].filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    const value = bits[0] ?? raw;
    return french ? `Résultat : ${value}` : `Result: ${value}`;
  } catch {
    return raw.slice(0, 400);
  }
}

async function completeTurn({
  apiKey,
  messages,
  send,
  tools,
  maxTokens,
}: {
  apiKey: string;
  messages: ApiMsg[];
  send: (obj: unknown) => void;
  tools?: typeof TOOL_DEFS;
  maxTokens: number;
}) {
  const upstream = await startCompletion(apiKey, {
    stream: true,
    max_tokens: maxTokens,
    temperature: 0.4,
    messages,
    ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  });

  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let streamedContent = false;
  const toolMap = new Map<number, ToolCall>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json: XDelta;
      try {
        json = JSON.parse(data) as XDelta;
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) send({ type: "thinking", text: reasoning });

      if (delta.content) {
        content += delta.content;
        send({ type: "token", text: delta.content });
        streamedContent = true;
      }

      if (delta.tool_calls) {
        for (const part of delta.tool_calls) {
          const index = part.index ?? 0;
          const current = toolMap.get(index) ?? {
            id: part.id ?? `call_${index}`,
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          if (part.id) current.id = part.id;
          if (part.function?.name) current.function.name += part.function.name;
          if (part.function?.arguments) current.function.arguments += part.function.arguments;
          toolMap.set(index, current);
        }
      }
    }
  }

  return {
    content,
    toolCalls: [...toolMap.values()].filter((t) => t.function.name),
    streamedContent,
  };
}

async function startCompletion(apiKey: string, payload: Record<string, unknown>) {
  const models = cachedUpstream ? [cachedUpstream] : [...FAST_MODELS];
  let lastStatus = 502;

  for (const model of models) {
    const body: Record<string, unknown> = { ...payload, model };
    if (model.includes("4.5") || model.endsWith("-reasoning")) {
      body.reasoning_effort = "low";
    }
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok && res.body) {
      cachedUpstream = model;
      return res;
    }
    lastStatus = res.status;
    if (res.status !== 400 && res.status !== 404) {
      throw new Error(`Inference error ${res.status}`);
    }
  }

  throw new Error(`Inference error ${lastStatus}`);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 240);
  }
}
