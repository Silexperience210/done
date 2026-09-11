/**
 * Modèles et outillage du studio — VÉRITÉ UNIQUEMENT.
 *
 * Historique : ce fichier annonçait « Edge0-35B / Edge0-8B » tournant « sur un
 * téléphone Android, 2,9 Go de RAM en pointe ». Ces chiffres venaient d'un VRAI
 * projet (Edge0, Apache-2.0) — un framework d'inférence à déchargement d'experts
 * sur SSD — mais Edge0 ne tourne QUE sur Apple Silicon (backend MLX ; le backend
 * CUDA est annoncé, pas écrit) et ne tourne donc sur aucun téléphone, aucun PC
 * Linux. L'application affichait une promesse intenable.
 *
 * Désormais : un modèle réellement exécutable dans la page, nommé, avec ses
 * chiffres réels. Les performances affichées sont MESURÉES sur l'appareil
 * (voir `src/ai/localModel.ts`), jamais écrites en dur.
 */
export type ModelId = "coder3b" | "coder15" | "coder05";

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

/**
 * Chiffres RÉELS :
 * - `diskGb`  : taille du téléchargement (depuis le Hub Hugging Face, mis en
 *               cache par le navigateur — aucune requête ensuite).
 * - `idleGb`  : poids du modèle résidents une fois chargé.
 * - `peakGb`  : majoré du cache KV pendant la génération.
 * Les débits (tok/s) ne sont PAS ici : ils dépendent de l'appareil et sont
 * mesurés à l'exécution.
 */
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
    repo: string;
    note: string;
  }
> = {
  coder3b: {
    id: "coder3b",
    name: "Qwen2.5-Coder-3B-Instruct",
    short: "Coder 3B",
    subtitle: "4 bits · WebGPU · dans le navigateur",
    params: "3 Md",
    diskGb: 2.0,
    idleGb: 1.9,
    peakGb: 2.3,
    repo: "onnx-community/Qwen2.5-Coder-3B-Instruct",
    note: "Le plus capable des trois, pour un téléphone avec 8-12 Go de RAM ou du swap.",
  },
  coder15: {
    id: "coder15",
    name: "Qwen2.5-Coder-1.5B-Instruct",
    short: "Coder 1.5B",
    subtitle: "4 bits · WebGPU · dans le navigateur",
    params: "1,5 Md",
    diskGb: 1.0,
    idleGb: 0.9,
    peakGb: 1.1,
    repo: "onnx-community/Qwen2.5-Coder-1.5B-Instruct",
    note: "Le meilleur modèle de code embarquable : HTML/CSS/JS, et il écrit un français correct.",
  },
  coder05: {
    id: "coder05",
    name: "Qwen2.5-Coder-0.5B-Instruct",
    short: "Coder 0.5B",
    subtitle: "4 bits · WebGPU · dans le navigateur",
    params: "0,5 Md",
    diskGb: 0.4,
    idleGb: 0.35,
    peakGb: 0.5,
    repo: "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
    note: "Le léger, pour les téléphones anciens : il démarre partout, plus approximatif.",
  },
};

export const SEED_PROMPT = "Explique l'inférence en flux en une phrase.";

export const SEED_REPLY =
  "En inférence en flux, le modèle produit les tokens un par un et les envoie au fur et à mesure, au lieu d'attendre d'avoir tout calculé avant de répondre.";

export const SUGGESTIONS = [
  "Un mini-jeu ping-pong que je peux lancer ici.",
  "Écris un mini-jeu snake que je peux lancer ici.",
  "Un canvas de particules que je peux essayer.",
  "Explique-moi ce qu'est un modèle MoE, en trois phrases.",
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
] as const;

export function wantsTools(text: string) {
  return /game|html|playable|scene|page|\bapp\b|interactive|canvas|widget|snake|particule|particle|jeu|code|calcul|puissance|compute|\boutil\b|tool|demo|démo/i.test(
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
  return name;
}

/**
 * Prompt système du modèle LOCAL. Il décrit ce que le modèle est réellement :
 * un petit modèle exécuté dans la page, sans accès réseau. Aucune consigne
 * demandant de dissimuler une origine cloud — il n'y a plus de cloud.
 */
export function systemPrompt(model: ModelId) {
  const m = MODELS[model];
  return [
    `Tu es ${m.name}, un petit modèle d'IA exécuté directement dans le navigateur de l'utilisateur (${m.params} paramètres, quantification 4 bits).`,
    "Tu fonctionnes entièrement hors ligne : tu n'as aucun accès à Internet, à un serveur ou à une API.",
    "Réponds de façon brève et utile, dans la langue de l'utilisateur.",
    "Pour un jeu, un canvas ou un widget : réponds UNIQUEMENT par un bloc de code ```html complet, sombre (#09090b), en JS/CSS natif, sans URL externe, moins de 120 lignes.",
    "Pour un calcul mental délicat, donne le résultat et l'étape intermédiaire.",
  ].join(" ");
}
