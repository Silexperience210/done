export type ModelId = "35b" | "8b";

export type ChatRole = "user" | "assistant";

export type ToolStatus = "start" | "done";

export type ToolEvent = {
  id: string;
  name: string;
  status: ToolStatus;
  args?: unknown;
  result?: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  thinking?: string;
  tools?: ToolEvent[];
};

export const MODELS: Record<
  ModelId,
  {
    id: ModelId;
    name: string;
    short: string;
    subtitle: string;
    params: string;
    diskGb: number;
    idleGb: number;
    peakGb: number;
    tokMin: number;
    tokMax: number;
    experts: number;
    topK: number;
    layers: number;
    activeGb: string;
  }
> = {
  "35b": {
    id: "35b",
    name: "Edge0-35B",
    short: "35B",
    subtitle: "A3B · 256 experts · K=4",
    params: "35B",
    diskGb: 23,
    idleGb: 1.84,
    peakGb: 3.98,
    tokMin: 14.9,
    tokMax: 17.7,
    experts: 256,
    topK: 4,
    layers: 40,
    activeGb: "up to 4 GB",
  },
  "8b": {
    id: "8b",
    name: "Edge0-8B",
    short: "8B",
    subtitle: "A1B · 128 experts · K=8",
    params: "8B",
    diskGb: 4.2,
    idleGb: 1.12,
    peakGb: 2.36,
    tokMin: 23.9,
    tokMax: 25.3,
    experts: 128,
    topK: 8,
    layers: 24,
    activeGb: "1–2.4 GB",
  },
};

export const SEED_PROMPT = "Explain streaming inference in one sentence.";

export const SEED_REPLY =
  "Streaming inference is the process of generating tokens (words or parts of words) one by one in real-time, as they are computed, rather than waiting for the entire sequence to be generated before outputting anything.";

export const SUGGESTIONS = [
  "Un mini-jeu ping-pong que je peux lancer ici.",
  "Écris un mini-jeu snake que je peux lancer ici.",
  "Un canvas de particules que je peux essayer.",
  "Calcule 17 puissance 6 avec un outil.",
] as const;

export const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "write_app",
      description:
        "Write a complete dark HTML app into the studio (game, canvas, widget). No external URLs.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          html: {
            type: "string",
            description: "Full HTML or body fragment. #09090b, vanilla JS/CSS/canvas, <160 lines.",
          },
        },
        required: ["title", "html"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_js",
      description: "Run a short JS snippet in a sandbox. Use for calculations.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "device_telemetry",
      description: "Read current RAM, tok/s, experts in RAM.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export function wantsTools(text: string) {
  return /game|html|playable|scene|page|\bapp\b|interactive|canvas|widget|snake|particule|particle|jeu|code|calcul|puissance|compute|\boutil\b|tool|telemetry|working set|\bram\b|expert|snake|demo|démo/i.test(
    text,
  );
}

export function isFrench(text: string) {
  return /[éèêëàâùûçîïœ]/i.test(text) || /\b(le|la|les|un|une|des|écris|calcule|comment|avec|pour|que|je)\b/i.test(text);
}

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function extractHtmlBlock(text: string): string | null {
  const fence = text.match(/```(?:html|HTML)\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const body = fence[1].trim();
    if (body.length > 40) return body;
  }
  const doc = text.match(/<!DOCTYPE html[\s\S]*<\/html>/i);
  return doc ? doc[0] : null;
}

export function extractFences(text: string): { lang: string; code: string }[] {
  const out: { lang: string; code: string }[] = [];
  const re = /```([a-zA-Z0-9]*)\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const code = m[2]?.trim() ?? "";
    if (code) out.push({ lang: (m[1] || "text").toLowerCase(), code });
  }
  return out;
}

export function toolLabel(name: string) {
  if (name === "write_app") return "write_app";
  if (name === "run_js") return "run_js";
  if (name === "device_telemetry") return "telemetry";
  return name;
}

export function systemPrompt(model: ModelId) {
  const m = MODELS[model];
  return [
    `You are ${m.name}, a ${m.params} sparse MoE model on an Android phone. Peak RAM ${m.activeGb}. Offline, local — never mention Grok, xAI, cloud, or remote APIs.`,
    "Be brief. Match the user's language.",
    "Games/canvas/widgets: call write_app, do not dump HTML in chat.",
    "Math/algorithms: call run_js.",
    "HTML: #09090b, no network, vanilla JS/CSS, under 120 lines.",
  ].join(" ");
}
