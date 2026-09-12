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
 * Désormais : un modèle réellement exécutable, nommé, avec ses chiffres réels.
 * L'inférence tourne sur l'appareil via llama.cpp en natif (voir
 * `src/ai/moteurNatif.ts`) ; les performances affichées sont MESURÉES sur
 * l'appareil, jamais écrites en dur.
 */
import type { EtatAchevement } from "@/ai/achevement";
import type { PasAgent } from "@/ai/agent";

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
  /**
   * La réponse ANALYSÉE du harnais — jamais la concaténation des sorties brutes
   * de chaque pas (c'était le défaut C4 : `content` accumulait les JSON de tous
   * les pas et la vraie réponse était ignorée). La sortie brute en cours vit
   * dans `brouillon`, le temps de la génération.
   */
  content: string;
  thinking?: string;
  tools?: ToolEvent[];
  /** Sortie brute du pas en cours, en flux (contrat, décision) : affichée dans le bloc de travail. */
  brouillon?: string;
  /** Chaque appel au moteur du tour, avec son bilan réel : la donnée de la frise. */
  pas?: PasAgent[];
  /** État d'achèvement du tour : critères ✓/✗, pas, tronqué, conclu. */
  achevement?: EtatAchevement;
};

/**
 * Chiffres RÉELS, alignés sur `MODELES_GGUF` (`src/ai/moteurNatif.ts`), la seule
 * liste dont les octets ont été relevés sur l'API du Hugging Face Hub :
 * - `diskGb` : taille du téléchargement du GGUF.
 * - `idleGb` : poids résidents une fois le modèle chargé (≈ la taille du fichier).
 *
 * PAS de `peakGb` : ce champ annonçait « poids + cache KV pendant la génération »
 * avec une réserve de KV INVENTÉE (0,4 Go pour le 1,5B comme pour le 0,5B et le
 * 30B — la même constante pour trois architectures). Aucun de ces octets n'était
 * mesuré. La mémoire affichée est donc désormais le seul chiffre réel dont on
 * dispose : le poids du fichier chargé, étiqueté comme tel à l'écran.
 *
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
    repo: string;
    note: string;
  }
> = {
  coder3b: {
    id: "coder3b",
    // NOM CORRIGÉ : ce n'est pas « Qwen2.5-Coder-3B-Instruct ». Le fichier
    // réellement téléchargé est `Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf`
    // (voir MODELES_GGUF), un 30B à experts dont 3B sont activés par jeton.
    // L'ancien libellé (« 3B », 3 Md de paramètres, 8,9 Go) désignait un modèle
    // qui n'existe pas dans l'appli.
    name: "Qwen3-Coder-30B-A3B-Instruct",
    short: "30B-A3B",
    subtitle: "GGUF · llama.cpp · sur l'appareil",
    params: "30 Md (3 activés)",
    diskGb: 8.005,
    idleGb: 8.005,
    repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    note: "8,0 Go de poids — 30 Md de paramètres dont 3 Md activés par jeton. Le plus gros des trois fichiers.",
  },
  coder15: {
    id: "coder15",
    name: "Qwen2.5-Coder-1.5B-Instruct",
    short: "1.5B",
    subtitle: "GGUF · llama.cpp · sur l'appareil",
    params: "1,5 Md",
    diskGb: 0.986,
    idleGb: 0.986,
    repo: "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    note: "0,99 Go de poids — 1,5 Md de paramètres en Q4_K_M. Le fichier intermédiaire.",
  },
  coder05: {
    id: "coder05",
    name: "Qwen2.5-Coder-0.5B-Instruct",
    short: "0.5B",
    subtitle: "GGUF · llama.cpp · sur l'appareil",
    params: "0,5 Md",
    diskGb: 0.398,
    idleGb: 0.398,
    repo: "bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF",
    note: "0,40 Go de poids — 0,5 Md de paramètres en Q4_K_M. Le plus petit des trois fichiers.",
  },
};

// SEED_PROMPT / SEED_REPLY SUPPRIMÉS.
// C'était une fausse conversation : une question écrite en dur ET sa réponse
// écrite en dur, affichées au premier lancement comme si le modèle les avait
// produites (« En inférence en flux, le modèle produit les tokens un par un… »).
// L'utilisateur l'a reconnue. Aucun modèle n'a jamais tourné pour l'écrire.
// La conversation démarre désormais VIDE : l'écran d'accueil propose des
// suggestions, et toute réponse affichée vient réellement du moteur local.

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
  return (
    /[éèêëàâùûçîïœ]/i.test(text) ||
    /\b(le|la|les|un|une|des|écris|calcule|comment|avec|pour|que|je)\b/i.test(text)
  );
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
 * un petit modèle exécuté sur l'appareil, sans accès réseau.
 *
 * CORRECTION IMPORTANTE (constatée sur téléphone) : cette fonction demandait
 * auparavant de répondre « UNIQUEMENT par un bloc ```html complet » dès qu'on
 * parlait de jeu, canvas ou widget. Résultat : le modèle déversait du HTML brut
 * dans la conversation au lieu de répondre, et cela entrait en conflit frontal
 * avec les règles d'appel d'outils du harnais. RÉPONDRE est désormais le
 * comportement par défaut, et une application s'écrit via l'outil `write_app`.
 */
export function systemPrompt(model: ModelId) {
  const m = MODELS[model];
  return [
    `Tu es ${m.name}, un petit modèle d'IA exécuté directement sur l'appareil de l'utilisateur (${m.params} paramètres, fichier GGUF quantifié).`,
    "Tu fonctionnes entièrement hors ligne : aucun accès à Internet, à un serveur ou à une API.",
    "Par défaut, tu RÉPONDS à l'utilisateur en texte clair, brièvement, dans sa langue. C'est ce qu'on attend de toi.",
    "Tu n'écris du code dans la conversation que si on te le demande explicitement.",
    "Pour créer une application, tu utilises l'outil write_app : une application ne se déverse JAMAIS en texte brut dans la conversation, elle s'écrit dans le studio.",
    "Pour un calcul délicat, tu utilises run_js.",
  ].join(" ");
}
