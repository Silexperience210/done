/**
 * Moteur NATIF — llama.cpp dans l'APK, au lieu de WebGPU bridé dans la WebView.
 *
 * Pourquoi c'est LA correction de vitesse : une WebView Android n'expose pas
 * WebGPU. L'appli retombait donc sur du WebAssembly mono-thread, mesuré à
 * **1,4 tok/s** sur le téléphone, contre 5 dans Chrome. Le moteur natif, lui,
 * utilise la RAM réelle de l'appareil (12 Go ici) et le déport GPU
 * (`n_gpu_layers`), donc il autorise à la fois un modèle utilisable et des
 * vitesses d'un autre ordre.
 *
 * Les modèles sont des GGUF, en quantifications agressives. Point clé, appris en
 * lisant les chiffres : en génération le coût dépend des octets LUS PAR JETON,
 * pas du nombre de paramètres. Un dense 8B en Q4 lit ~5 Go par jeton ; un modèle
 * à experts (MoE) de 30B n'en lit que ~1,2 Go parce qu'il n'active que 3B à la
 * fois. D'où la présence du 30B-A3B quantifié à l'extrême dans la liste : quatre
 * fois plus gros, plus rapide.
 *
 * Le module n'importe PAS le plugin : on le lui passe. C'est ce qui permet de le
 * tester sans Android, avec un simulacre.
 */
import type { GenerateOptions, LocalModelId, ProgresChargement } from "./localModel.ts";
import type { Moteur } from "./moteur.ts";

export type ModeleGguf = {
  /** Identifiant local, aligné sur les étages du navigateur. */
  id: LocalModelId;
  nom: string;
  court: string;
  /** Fichier GGUF attendu sur l'appareil. */
  fichier: string;
  /** Taille RÉELLE du fichier, relevée sur l'API du Hub (Go). */
  tailleGo: number;
  /** Octets lus par jeton, en Q4 : ce qui décide vraiment de la vitesse. */
  lectureGoParJeton: number;
  note: string;
};

/**
 * Tailles MESURÉES sur le Hub (pas estimées). Les deux premiers sont des denses,
 * les deux derniers la réponse au problème de vitesse : à experts, gros mais peu
 * lus à chaque jeton.
 */
export const MODELES_GGUF: readonly ModeleGguf[] = [
  {
    id: "coder05",
    nom: "Qwen2.5-Coder-0.5B-Instruct (Q4_K_M)",
    court: "0.5B Q4",
    fichier: "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
    tailleGo: 0.398,
    lectureGoParJeton: 0.4,
    note: "Le plus léger. Sert à prouver que la chaîne native fonctionne.",
  },
  {
    id: "coder15",
    nom: "Qwen2.5-Coder-1.5B-Instruct (Q4_K_M)",
    court: "1.5B Q4",
    fichier: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
    tailleGo: 0.986,
    lectureGoParJeton: 1.0,
    note: "Bon compromis sur un téléphone récent, et fiable pour les outils.",
  },
  {
    id: "coder3b",
    nom: "Qwen3-Coder-30B-A3B-Instruct (UD-TQ1_0, 1 bit)",
    court: "30B-A3B 1 bit",
    fichier: "Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf",
    tailleGo: 8.0,
    lectureGoParJeton: 1.3,
    note: "Le pari : 30B de connaissances, 3B activés, donc peu d'octets lus par jeton — plus rapide qu'un dense 8B malgré quatre fois plus de poids. Huit Go sur douze, limite haute. La fiabilité des appels d'outils à 1 bit reste à prouver.",
  },
];

export function modeleGguf(id: LocalModelId): ModeleGguf {
  return MODELES_GGUF.find((m) => m.id === id) ?? MODELES_GGUF[1];
}

/** Ce qu'on attend du plugin, et rien de plus (donc simulable). */
export type PluginLlama = {
  initLlama: (params: Record<string, unknown>) => Promise<unknown>;
  completion: (
    params: Record<string, unknown>,
    callback?: (data: { token?: string }) => void,
  ) => Promise<{ text?: string; timings?: { predicted_per_second?: number } }>;
  releaseAllLlama?: () => Promise<void>;
};

export type OptionsNatif = {
  /** Où trouver le GGUF sur l'appareil. */
  cheminModele: (m: ModeleGguf) => string;
  /**
   * Le GGUF est EMBARQUÉ dans les ressources de l'appli (assets Android / bundle
   * iOS) au lieu d'être posé sur le système de fichiers. Dans ce cas llama.cpp
   * attend le NOM DE FICHIER SEUL, et c'est `is_model_asset: true` qui le lui
   * dit. Sans cette option, on garde le comportement d'origine : un chemin.
   */
  asset?: boolean;
  /** Charge le plugin (import dynamique en vrai, simulacre dans les tests). */
  chargerPlugin: () => Promise<PluginLlama>;
  nbCoeurs?: () => number;
  /** Couches déportées sur le GPU. Élevé par défaut : c'est le gain de vitesse. */
  couchesGpu?: number;
};

function gabaritQwen(system: string, history: { role: string; content: string }[]): string {
  const parts = [`<|im_start|>system\n${system}<|im_end|>\n`];
  for (const m of history) {
    parts.push(`<|im_start|>${m.role === "assistant" ? "assistant" : "user"}\n${m.content}<|im_end|>\n`);
  }
  parts.push("<|im_start|>assistant\n");
  return parts.join("");
}

/**
 * Contrat complet d'un moteur natif : le `Moteur` commun, plus ce qui n'a de
 * sens qu'en natif (vitesse mesurée par llama.cpp, modèle réellement chargé).
 */
export type MoteurNatif = Moteur & {
  /** Vitesse MESURÉE par llama.cpp sur le dernier appel (tok/s). */
  derniereVitesse: () => number | null;
  /** Chemin du modèle actuellement chargé. */
  modeleCharge: () => string | null;
};

/**
 * Construit le moteur natif. Tout ce qui touche au matériel est injecté, donc la
 * logique est vérifiable sans téléphone.
 */
export function creerMoteurNatif(opts: OptionsNatif): MoteurNatif {
  let contexte: unknown = null;
  let charge: LocalModelId | null = null;
  let dernierTokParSeconde: number | null = null;

  return {
    nom: "natif",

    pret: () => contexte !== null,

    derniereVitesse: () => dernierTokParSeconde,

    modeleCharge: () => (contexte === null ? null : opts.cheminModele(modeleGguf(charge ?? "coder15"))),

    async charger(id: LocalModelId, onProgres?: (p: ProgresChargement) => void): Promise<void> {
      const debut = Date.now();
      if (contexte && charge === id) return;

      const plugin = await opts.chargerPlugin();
      const modele = modeleGguf(id);
      const chemin = opts.cheminModele(modele);
      const coeurs = Math.max(2, (opts.nbCoeurs?.() ?? 8) - 1);

      onProgres?.({
        phase: "initialisation",
        pct: 100,
        fichier: `${modele.court} → mémoire`,
        ecouleMs: Date.now() - debut,
      });

      if (contexte && charge && charge !== id) {
        await plugin.releaseAllLlama?.();
        contexte = null;
      }

      contexte = await plugin.initLlama({
        model: chemin,
        // Modèle embarqué : llama.cpp va le chercher dans les ressources de
        // l'appli et veut le nom de fichier seul ; `is_model_asset` le lui
        // indique. Absent, on passe un chemin, comportement d'origine.
        ...(opts.asset ? { is_model_asset: true } : {}),
        n_ctx: 2048,
        n_batch: 256,
        n_threads: coeurs,
        // Tout déporter sur le GPU est le seul réglage qui change vraiment
        // l'ordre de grandeur de la vitesse.
        n_gpu_layers: opts.couchesGpu ?? 99,
        use_mlock: false,
      });
      charge = id;
      onProgres?.({ phase: "pret", pct: 100, fichier: "", ecouleMs: Date.now() - debut });
    },

    async generer(options: GenerateOptions): Promise<string> {
      if (!contexte) throw new Error("aucun modèle natif chargé");
      const plugin = await opts.chargerPlugin();
      const prompt = gabaritQwen(options.system, options.history);
      let flux = "";

      const resultat = await plugin.completion(
        {
          prompt,
          n_predict: options.maxNewTokens ?? 256,
          temperature: 0.2,
          top_p: 0.9,
          emit_partial_completion: true,
          // S'arrêter à la balise de fin évite de générer 256 jetons pour rien :
          // sur un téléphone, c'est du temps réel gagné.
          stop: ["<|im_end|>", "<|im_start|>"],
        },
        (data) => {
          if (typeof data?.token === "string") {
            flux += data.token;
            options.onToken?.(data.token);
          }
        },
      );

      // llama.cpp rend la vitesse qu'il a MESURÉE : on la remonte telle quelle,
      // au lieu de l'estimer à partir d'une longueur de texte.
      const mesure = resultat?.timings?.predicted_per_second;
      if (typeof mesure === "number" && mesure > 0) {
        dernierTokParSeconde = mesure;
        const jetons = Math.round(flux.length / 4);
        options.onVitesse?.(mesure, jetons, 0);
      }

      const texte = (flux || resultat?.text || "").replace(/<\|im_(end|start)\|>/g, "");
      return texte.trim();
    },
  };
}

/**
 * Ce que le plugin llama-cpp-capacitor expose réellement, réduit au strict
 * nécessaire. On ne dépend PAS de ses propres types : c'est une dépendance
 * native, absente du build navigateur, et son API évolue. Un contrat minimal
 * nous garde compilables et lisibles.
 */
type PluginLlamaBrut = {
  initLlama?: (params: Record<string, unknown>) => Promise<unknown>;
  releaseAllLlama?: () => Promise<void>;
};

/** Le contexte rendu par `initLlama` : c'est LUI qui porte `completion`. */
type ContextePlugin = { completion?: PluginLlama["completion"] };

/**
 * Fabrique PRÊTE À L'EMPLOI, pour le vrai plugin Capacitor.
 *
 * Deux points appris à la dure, tous deux encodés ici :
 *
 *  1. **L'import doit être DYNAMIQUE et à l'appel.** Le plugin n'existe que dans
 *     l'APK ; l'importer au chargement du module ferait échouer le build
 *     navigateur, et ferait résoudre du code natif côté serveur.
 *  2. **`completion` vit SUR le contexte, pas à plat.** L'API réelle est
 *     `contexte = await initLlama(...)` puis `contexte.completion(...)`, alors
 *     que `PluginLlama` (et ses tests) attend `completion` au premier niveau. On
 *     adapte ICI, une seule fois, au lieu de tordre la logique du moteur : le
 *     contrat simulable reste exactement celui que testent les tests.
 */
export async function moteurNatifParDefaut(
  /**
   * Où trouver le GGUF. En mode `asset`, on lui passe le NOM DE FICHIER SEUL
   * (`modeleGguf(id).fichier`) : le GGUF est embarqué dans les ressources de
   * l'appli, llama.cpp le résout par son nom.
   */
  cheminModele: (m: ModeleGguf) => string,
  asset?: boolean,
): Promise<MoteurNatif> {
  // Import dynamique : jamais résolu tant que cette branche n'est pas exécutée.
  // C'est précisément ce qui garde le build navigateur intact.
  const mod = (await import("llama-cpp-capacitor")) as unknown as PluginLlamaBrut;

  let contexte: ContextePlugin | null = null;
  const adaptateur: PluginLlama = {
    initLlama: async (params) => {
      if (typeof mod.initLlama !== "function") {
        throw new Error("le plugin llama-cpp-capacitor n'expose pas initLlama");
      }
      contexte = (await mod.initLlama(params)) as ContextePlugin;
      return contexte;
    },
    completion: (params, cb) => {
      // Referme sur le contexte chargé : c'est lui qui a la méthode.
      const c = contexte;
      if (!c || typeof c.completion !== "function") {
        throw new Error("aucun contexte llama.cpp chargé : appelle charger() d'abord");
      }
      return c.completion(params, cb);
    },
  };
  const libere = mod.releaseAllLlama?.bind(mod);
  if (libere) adaptateur.releaseAllLlama = () => libere();

  return creerMoteurNatif({ cheminModele, asset, chargerPlugin: async () => adaptateur });
}
