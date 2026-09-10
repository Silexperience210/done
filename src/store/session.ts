import { create } from "zustand";
import {
  extractHtmlBlock,
  MODELS,
  newId,
  SEED_PROMPT,
  SEED_REPLY,
  type ChatMessage,
  type ModelId,
  type ToolEvent,
} from "@/lib/edge0";
import { resolveLocalTurn } from "@/lib/local-apps";

export type StudioTab = "preview" | "code";

export type StudioState = {
  title: string;
  html: string;
};

type SessionState = {
  model: ModelId;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  memoryGb: number;
  tokPerSec: number;
  studio: StudioState | null;
  studioTab: StudioTab;
  studioOpen: boolean;
  setModel: (id: ModelId) => void;
  send: (text: string) => Promise<void>;
  clear: () => void;
  openStudio: (tab?: StudioTab) => void;
  closeStudio: () => void;
  setStudioTab: (tab: StudioTab) => void;
  tickIdle: (t: number) => void;
};

const seedMessages: ChatMessage[] = [
  { id: "seed-u", role: "user", content: SEED_PROMPT },
  { id: "seed-a", role: "assistant", content: SEED_REPLY },
];

function restingMemory(model: ModelId, hasReply: boolean) {
  const m = MODELS[model];
  if (!hasReply) return m.idleGb;
  return m.idleGb + (m.peakGb - m.idleGb) * 0.42;
}

export const useSession = create<SessionState>((set, get) => ({
  model: "35b",
  messages: seedMessages,
  streaming: false,
  error: null,
  memoryGb: 2.84,
  tokPerSec: 15.8,
  studio: null,
  studioTab: "preview",
  studioOpen: false,

  setModel: (id) => {
    if (get().streaming) return;
    const hasReply = get().messages.some((m) => m.role === "assistant" && m.content);
    set({
      model: id,
      memoryGb: restingMemory(id, hasReply),
      tokPerSec: hasReply ? MODELS[id].tokMin + 0.9 : 0,
    });
  },

  clear: () => {
    if (get().streaming) return;
    set({
      messages: [],
      error: null,
      studio: null,
      studioOpen: false,
      tokPerSec: 0,
      memoryGb: MODELS[get().model].idleGb,
    });
  },

  openStudio: (tab) =>
    set((s) => ({
      studioOpen: true,
      studioTab: tab ?? s.studioTab,
    })),
  closeStudio: () => set({ studioOpen: false }),
  setStudioTab: (tab) => set({ studioTab: tab }),

  tickIdle: (t) => {
    if (get().streaming) return;
    const hasReply = get().messages.some((m) => m.role === "assistant" && m.content);
    const base = restingMemory(get().model, hasReply);
    set({
      memoryGb: base + Math.sin(t / 1400) * 0.03 + Math.sin(t / 410) * 0.015,
    });
  },

  send: async (raw) => {
    const text = raw.trim();
    if (!text || get().streaming) return;

    const user: ChatMessage = { id: newId(), role: "user", content: text };
    const assistant: ChatMessage = {
      id: newId(),
      role: "assistant",
      content: "",
      thinking: "",
      tools: [],
    };
    const history = [...get().messages, user];
    const profile = MODELS[get().model];
    set({
      messages: [...history, assistant],
      streaming: true,
      error: null,
      tokPerSec: profile.tokMin,
      memoryGb: profile.idleGb + (profile.peakGb - profile.idleGb) * 0.45,
    });

    const started = performance.now();
    let tokens = 0;
    let content = "";
    let thinking = "";
    const tools: ToolEvent[] = [];

    const patchAssistant = (extra?: Partial<SessionState>) => {
      set((s) => ({
        ...extra,
        messages: s.messages.map((m) =>
          m.id === assistant.id ? { ...m, content, thinking, tools: [...tools] } : m,
        ),
      }));
    };

    const pulse = (ratio: number) => {
      const elapsed = Math.max(0.2, (performance.now() - started) / 1000);
      const tok =
        tokens > 0
          ? Math.min(profile.tokMax + 0.8, Math.max(profile.tokMin - 0.6, tokens / elapsed))
          : profile.tokMin * 0.7;
      const mem =
        profile.idleGb +
        (profile.peakGb - profile.idleGb) * ratio +
        Math.sin(elapsed * 6) * 0.05;
      return { tokPerSec: tok, memoryGb: mem };
    };

    try {
      const turn = resolveLocalTurn(text);
      if (turn.kind !== "chat") {
        await sleep(180);
        thinking =
          turn.kind === "app"
            ? "Prerouter → write_app · studio preview"
            : "Prerouter → run_js · sandbox";
        patchAssistant(pulse(0.55));
        await sleep(140);
        const toolName = turn.kind === "app" ? "write_app" : "run_js";
        tools.push({
          id: newId(),
          name: toolName,
          status: "start",
          args: turn.kind === "app" ? { title: turn.app.title } : { code: turn.expression },
        });
        patchAssistant(pulse(0.78));
        await sleep(120);
        tools[0] = {
          ...tools[0],
          status: "done",
          result: turn.kind === "app" ? turn.app.title : turn.value,
        };
        if (turn.kind === "app") {
          content = turn.app.note;
          tokens = 12;
          set({
            studio: { title: turn.app.title, html: turn.app.html },
            studioTab: "preview",
            studioOpen: true,
            error: null,
          });
        } else {
          content = turn.note;
          tokens = 8;
        }
        patchAssistant({
          ...pulse(0.92),
          streaming: false,
          memoryGb: restingMemory(get().model, true),
          error: null,
        });
        return;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model: get().model,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => ({ error: "Inference failed" }));
        throw new Error(
          typeof errBody?.error === "string" ? errBody.error : "Inference failed",
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pending = "";
      let raf = 0;

      const flushTokens = () => {
        raf = 0;
        if (!pending) return;
        content += pending;
        tokens += Math.max(1, Math.round(pending.length / 4));
        pending = "";
        patchAssistant(pulse(0.92));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let evt: {
            type?: string;
            text?: string;
            error?: string;
            id?: string;
            name?: string;
            status?: "start" | "done";
            args?: unknown;
            result?: string;
            title?: string;
            html?: string;
          };
          try {
            evt = JSON.parse(data) as typeof evt;
          } catch {
            continue;
          }

          if (evt.type === "thinking" && evt.text) {
            thinking += evt.text;
            patchAssistant(pulse(0.55));
          } else if (evt.type === "token" && evt.text) {
            if (!content && !pending) {
              pending = evt.text;
              flushTokens();
            } else {
              pending += evt.text;
              if (!raf) raf = requestAnimationFrame(flushTokens);
            }
          } else if (evt.type === "tool" && evt.id && evt.name) {
            const existing = tools.findIndex((t) => t.id === evt.id);
            const next: ToolEvent = {
              id: evt.id,
              name: evt.name,
              status: evt.status ?? "start",
              args: evt.args,
              result: evt.result,
            };
            if (existing >= 0) tools[existing] = { ...tools[existing], ...next };
            else tools.push(next);
            patchAssistant(pulse(0.78));
          } else if (evt.type === "app" && evt.html && evt.title) {
            set({
              studio: { title: evt.title, html: evt.html },
              studioTab: "preview",
              studioOpen: true,
            });
          } else if (evt.type === "error") {
            throw new Error(evt.error || "Inference failed");
          }
        }
      }

      if (raf) cancelAnimationFrame(raf);
      flushTokens();

      const fence = extractHtmlBlock(content);
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistant.id
            ? { ...m, content: content || m.content, thinking, tools: [...tools] }
            : m,
        ),
        streaming: false,
        memoryGb: restingMemory(s.model, true),
        studio:
          fence && !s.studio
            ? { title: "Generated", html: wrapHtml(fence) }
            : s.studio,
      }));
    } catch {
      const turn = resolveLocalTurn(text, true);
      if (turn.kind === "app") {
        set({
          streaming: false,
          error: null,
          studio: { title: turn.app.title, html: turn.app.html },
          studioTab: "preview",
          studioOpen: true,
          memoryGb: restingMemory(get().model, true),
          messages: get().messages.map((m) =>
            m.id === assistant.id
              ? { ...m, thinking, tools: [...tools], content: turn.app.note }
              : m,
          ),
        });
        return;
      }
      const note = turn.kind === "calc" ? turn.note : turn.content;
      set((s) => ({
        streaming: false,
        memoryGb: restingMemory(s.model, true),
        error: null,
        messages: s.messages.map((m) =>
          m.id === assistant.id
            ? { ...m, thinking, tools: [...tools], content: note }
            : m,
        ),
      }));
    }
  },
}));

function wrapHtml(html: string) {
  if (/<html/i.test(html)) return html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>html,body{margin:0;background:#09090b;color:#ececef;font:14px system-ui}</style></head><body>${html}</body></html>`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function htmlFrom(message: ChatMessage): string | null {
  return extractHtmlBlock(message.content);
}
