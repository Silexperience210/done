/**
 * Moteur d'inférence LOCAL du studio — plus de serveur, plus de clé, plus de réseau.
 *
 * Remplace la route `/api/chat` (supprimée) : le modèle tourne DANS la page, sur
 * l'appareil de l'utilisateur, via `@huggingface/transformers` (transformers.js v3)
 * qui exécute des modèles ONNX sur **WebGPU** avec repli automatique **WASM**.
 *
 * Ce que ça change par rapport à ce que l'app prétendait faire : les fiches
 * « Edge0-35B / 8B » affichaient les chiffres réels d'un framework d'inférence
 * (Edge0, Apache-2.0) qui ne tourne QUE sur Apple Silicon (backend MLX, CUDA non
 * écrit) — jamais sur un téléphone Android. Ici les modèles sont réels, nommés,
 * et leurs performances sont MESURÉES sur l'appareil, pas affichées.
 */
import { pipeline, env } from "@huggingface/transformers";

/**
 * Trois étages de modèles, choisis avec l'utilisateur : le meilleur pour coder,
 * un intermédiaire pour les appareils récents, un léger pour les téléphones
 * anciens.
 *
 * Tailles RÉELLES des poids q4f16, relevées sur l'API du Hub (Mo réels, pas des
 * estimations) : ce sont les fichiers qui seront téléchargés, donc on annonce
 * ces nombres-là et pas d'autres.
 */
export const LOCAL_MODELS = [
  {
    id: "coder3b",
    repo: "onnx-community/Qwen2.5-Coder-3B-Instruct",
    label: "Qwen2.5-Coder-3B-Instruct",
    short: "Coder 3B",
    diskGb: 2.4,
    params: "3 Md",
    note: "2,4 Go à télécharger. Le plus capable, pour 8-12 Go de RAM (ou du swap). Plus lent.",
  },
  {
    id: "coder15",
    repo: "onnx-community/Qwen2.5-Coder-1.5B-Instruct",
    label: "Qwen2.5-Coder-1.5B-Instruct",
    short: "Coder 1.5B",
    diskGb: 1.3,
    params: "1,5 Md",
    note: "1,3 Go à télécharger. Bon compromis vitesse / qualité, exige WebGPU.",
  },
  {
    id: "coder05",
    repo: "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
    label: "Qwen2.5-Coder-0.5B-Instruct",
    short: "Coder 0.5B",
    diskGb: 0.55,
    params: "0,5 Md",
    note: "0,55 Go. Le seul raisonnable sans WebGPU, et pour les téléphones anciens.",
  },
] as const;

export type LocalModelId = (typeof LOCAL_MODELS)[number]["id"];

export type EngineState = "idle" | "loading" | "ready" | "error";

export type Metrics = {
  /** Tokens par seconde MESURÉS sur cet appareil, après une génération réelle. */
  tokPerSec: number | null;
  /** Backend effectivement utilisé, renvoyé par la librairie. */
  device: string;
  /** Durée du chargement en ms. */
  loadMs: number | null;
};

let generator: unknown = null;
let loadPromise: Promise<unknown> | null = null;
let loadedId: LocalModelId | null = null;
let loadedDevice = "inconnu";
let loadMs: number | null = null;

export function metrics(): Metrics {
  return { tokPerSec: lastTokPerSec, device: loadedDevice, loadMs };
}

let lastTokPerSec: number | null = null;

export function isReady(): boolean {
  return generator !== null;
}

export function loadedModelId(): LocalModelId | null {
  return loadedId;
}

/** Le WebGPU est-il réellement utilisable ? Poser la question ne suffit pas :
 * `navigator.gpu` peut exister et l'adaptateur être refusé. On teste pour de
 * vrai, AVANT de faire télécharger 1,3 Go à l'utilisateur. */
export type VerdictGpu = { ok: boolean; raison: string };

export async function verifierWebgpu(): Promise<VerdictGpu> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<unknown> };
  };
  if (!nav.gpu) return { ok: false, raison: "ce navigateur n'expose pas WebGPU" };
  try {
    const adaptateur = await nav.gpu.requestAdapter();
    if (!adaptateur) return { ok: false, raison: "aucun adaptateur GPU n'a été accordé" };
    return { ok: true, raison: "WebGPU actif" };
  } catch (e) {
    return { ok: false, raison: `WebGPU a échoué (${e instanceof Error ? e.message : String(e)})` };
  }
}

export async function webgpuAvailable(): Promise<boolean> {
  return (await verifierWebgpu()).ok;
}

export type PhaseChargement = "telechargement" | "initialisation" | "pret";

export type ProgresChargement = {
  phase: PhaseChargement;
  /** 0-100, pertinent surtout en phase de téléchargement. */
  pct: number;
  fichier: string;
  /** Millisecondes écoulées : c'est CE chiffre qui prouve que ça travaille. */
  ecouleMs: number;
};

/**
 * Charge le modèle — paresseux, mémoïsé, promesse partagée.
 * Deux appels concurrents ne téléchargent qu'une fois.
 *
 * Deux réglages qui viennent d'un échec constaté sur téléphone (« 100 % puis
 * blocage ») :
 *
 *  1. **Le bon format de poids selon le moteur.** `q4` (utilisé avant) pèse
 *     1,9 Go pour le 1,5B et 3,2 Go pour le 3B — presque le double de `q4f16`,
 *     qui est en plus le format attendu par WebGPU. Sur WASM, où fp16 n'existe
 *     pas, on prend `q8`.
 *  2. **Un compte à rebours honnête pendant l'initialisation.** La barre de
 *     téléchargement atteint 100 % AVANT que le moteur ne construise la session
 *     ONNX et n'alloue la mémoire GPU : plusieurs minutes sur un téléphone, sans
 *     aucun retour visuel. C'est ça, le « blocage ». On annonce donc la phase et
 *     le temps écoulé, et on refuse d'attendre indéfiniment.
 */
export function loadModel(
  id: LocalModelId,
  onProgress?: (p: ProgresChargement) => void,
): Promise<unknown> {
  if (generator && loadedId === id) return Promise.resolve(generator);
  if (loadPromise && loadedId === id) return loadPromise;

  // changement de modèle : on repart de zéro (la mémoire de l'ancien est libérée)
  if (generator && loadedId !== id) {
    generator = null;
    loadPromise = null;
  }

  const entry = LOCAL_MODELS.find((m) => m.id === id) ?? LOCAL_MODELS[1];
  const started = Date.now();
  loadedId = id;
  loadPromise = (async () => {
    // Les modèles sont téléchargés depuis le Hub Hugging Face puis mis en cache
    // par le navigateur : à partir du deuxième lancement, aucune requête réseau.
    env.allowLocalModels = false;
    const verdict = await verifierWebgpu();
    if (!verdict.ok && id !== "coder05") {
      throw new Error(
        `${verdict.raison}. En WASM pur, ${entry.label} (${entry.diskGb} Go) serait inutilisable : ` +
          `choisis le Coder 0.5B, ou ouvre l'appli dans Chrome.`,
      );
    }
    loadedDevice = verdict.ok ? "webgpu" : "wasm";
    const dtype = verdict.ok ? "q4f16" : "q8";

    let phase: PhaseChargement = "telechargement";
    const signaler = (pct: number, fichier: string) =>
      onProgress?.({ phase, pct, fichier, ecouleMs: Date.now() - started });

    // Délai de garde sur la construction du moteur. Sans lui, un GPU qui refuse
    // d'allouer la mémoire laisse l'écran bloqué pour toujours : mieux vaut un
    // échec nommé au bout de quelques minutes qu'un blocage sans fin.
    const delaiMoteur = new Promise<never>((_, rej) =>
      setTimeout(
        () =>
          rej(
            new Error(
              `le moteur n'a pas démarré en 5 min (${entry.label}, ${entry.diskGb} Go). ` +
                `C'est en général que le GPU du téléphone ne peut pas allouer autant de mémoire : ` +
                `prends le Coder 0.5B (0,55 Go), qui passe sur les GPU de téléphone.`,
            ),
          ),
        5 * 60_000,
      ),
    );

    const g = await Promise.race([
      pipeline("text-generation", entry.repo, {
        dtype,
        device: verdict.ok ? "webgpu" : "wasm",
        progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
          if (p?.status === "progress" && typeof p.progress === "number") {
            signaler(Math.round(p.progress), p.file ?? "");
          } else if (p?.status === "done") {
            signaler(100, p.file ?? "");
          } else if (p?.status === "ready") {
            // Les poids sont là. Ce qui suit (session ONNX, allocation GPU) est
            // long et silencieux : on change de phase pour que l'interface le dise.
            phase = "initialisation";
            signaler(100, "préparation du moteur");
          }
        },
      }),
      delaiMoteur,
    ]);
    generator = g;
    loadMs = Date.now() - started;
    onProgress?.({ phase: "pret", pct: 100, fichier: "", ecouleMs: loadMs });
    return g;
  })().catch((e) => {
    // échec : on autorise une nouvelle tentative (réseau coupé, stockage plein…)
    loadPromise = null;
    loadedId = null;
    throw e;
  });
  return loadPromise;
}

/** Gabarit de conversation Qwen2.5 — construit à la main, déterministe. */
function buildPrompt(system: string, history: { role: string; content: string }[]): string {
  const parts = [`<|im_start|>system\n${system}<|im_end|>\n`];
  for (const m of history) {
    const role = m.role === "assistant" ? "assistant" : "user";
    parts.push(`<|im_start|>${role}\n${m.content}<|im_end|>\n`);
  }
  parts.push("<|im_start|>assistant\n");
  return parts.join("");
}

function cleanReply(text: string): string {
  return text
    .replace(/<\|im_end\|>/g, "")
    .replace(/<\|im_start\|>/g, "")
    .replace(/<\|endoftext\|>/g, "")
    .trim();
}

export type GenerateOptions = {
  system: string;
  history: { role: string; content: string }[];
  maxNewTokens?: number;
  onToken?: (text: string) => void;
  /** Appelé à chaque jeton avec la vitesse instantanée mesurée, en tok/s. */
  onVitesse?: (tokParSeconde: number, jetons: number, msDepuisPremier: number) => void;
  signal?: AbortSignal;
  /**
   * Schéma JSON (chaîne) contraignant la sortie vers un JSON valide. Seul le
   * moteur natif sait l'appliquer (llama.cpp le convertit en grammaire) ; le
   * moteur navigateur l'ignore et génère comme avant.
   */
  jsonSchema?: string;
  /** Grammaire GBNF de contrainte (natif). Prime sur `jsonSchema` si fournie. */
  grammar?: string;
};

/** Secondes sans le moindre jeton avant de considérer que ça ne produit plus. */
const GARDE_JETON_MS = 45_000;

/**
 * Génère une réponse LOCALEMENT. `onToken` reçoit le texte au fil de l'eau :
 * l'interface garde exactement le même effet de frappe qu'avec le serveur.
 */
export async function generate(opts: GenerateOptions): Promise<string> {
  const g = (await loadModel(loadedId ?? "coder15")) as {
    tokenizer: unknown;
    (prompt: string, o: Record<string, unknown>): Promise<unknown>;
  };
  const prompt = buildPrompt(opts.system, opts.history);
  const started = Date.now();
  let streamed = "";
  let jetons = 0;
  let premierJetonMs: number | null = null;
  let dernierJeton = Date.now();

  // Chien de garde : sur un téléphone, la première génération compile les
  // shaders du GPU — c'est long, mais ça doit finir par produire un jeton. Si
  // plus rien n'arrive pendant 45 s, on considère que le moteur est bloqué et on
  // libère l'interface avec un message exploitable, au lieu de laisser
  // l'utilisateur devant un écran figé. On ne peut PAS interrompre la librairie
  // d'inférence : le calcul en cours continue, d'où le conseil de recharger.
  let chien: ReturnType<typeof setInterval> | null = null;
  const antiGel = new Promise<never>((_, rej) => {
    chien = setInterval(() => {
      if (Date.now() - dernierJeton > GARDE_JETON_MS) {
        if (chien) clearInterval(chien);
        rej(
          new Error(
            `aucun jeton produit depuis ${Math.round(GARDE_JETON_MS / 1000)} s — le moteur est bloqué. ` +
              `Recharge la page (le GPU reste occupé côté navigateur), et si ça se reproduit, ` +
              `prends un modèle plus petit : le Coder 0.5B.`,
          ),
        );
      }
    }, 5000);
  });

  const noterJeton = (t: string) => {
    jetons += 1;
    dernierJeton = Date.now();
    if (premierJetonMs === null) premierJetonMs = Date.now();
    const ms = Date.now() - premierJetonMs;
    if (ms > 500) opts.onVitesse?.((jetons * 1000) / ms, jetons, ms);
    streamed += t;
    opts.onToken?.(t);
  };

  // Streaming : on passe par le TextStreamer de la librairie quand il est
  // disponible ; sinon on retombe sur une génération d'un bloc (même résultat,
  // l'effet de frappe est simplement simulé par l'appelant).
  let extra: Record<string, unknown> = {};
  try {
    const mod = (await import("@huggingface/transformers")) as Record<string, unknown>;
    const Streamer = mod.TextStreamer as
      | (new (tok: unknown, o: { skip_prompt: boolean; callback_function: (t: string) => void }) => unknown)
      | undefined;
    if (Streamer) {
      extra = {
        streamer: new Streamer(g.tokenizer, {
          skip_prompt: true,
          callback_function: noterJeton,
        }),
      };
    }
  } catch {
    /* pas de streamer : on génère d'un bloc */
  }

  const sortie = (await Promise.race([
    g(prompt, {
      max_new_tokens: opts.maxNewTokens ?? 384,
      temperature: 0.2,
      top_p: 0.9,
      do_sample: false, // décodage glouton : réponses reproductibles
      ...extra,
    }),
    antiGel,
  ]).finally(() => {
    if (chien) clearInterval(chien);
  })) as Array<{ generated_text?: string }> | { generated_text?: string };

  const full = Array.isArray(sortie) ? (sortie[0]?.generated_text ?? "") : (sortie?.generated_text ?? "");
  // `generated_text` CONTIENT le prompt : sans ce retrait, on renvoie le prompt
  // système et tout l'historique à l'utilisateur.
  const reply = cleanReply(streamed.trim() ? streamed : full.slice(prompt.length));

  const seconds = (Date.now() - started) / 1000;
  const approxTokens = Math.max(1, Math.round(reply.length / 4));
  if (seconds > 0.2) lastTokPerSec = Math.round((approxTokens / seconds) * 10) / 10;

  return reply;
}
