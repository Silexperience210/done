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
    nom: "Qwen3-Coder-30B-A3B-Instruct (UD-IQ1_S, 1 bit)",
    court: "30B-A3B 1 bit",
    // Nom EXACT du fichier dans le dépôt unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF
    // (vérifié sur l'API du Hub). UD-IQ1_S remplace UD-TQ1_0 : à taille voisine
    // (8,9 Go contre 8,0), il est calibré par matrice d'importance, donc
    // sensiblement plus juste à budget de bits comparable.
    fichier: "Qwen3-Coder-30B-A3B-Instruct-UD-IQ1_S.gguf",
    tailleGo: 8.9,
    lectureGoParJeton: 1.3,
    note: "Le pari : 30B de connaissances, 3B activés, donc peu d'octets lus par jeton — plus rapide qu'un dense 8B malgré quatre fois plus de poids. 8,9 Go sur douze, limite haute. La fiabilité des appels d'outils à 1 bit reste à prouver.",
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
  /**
   * Sauve l'état du prompt/du cache KV dans un fichier. C'est la méthode du
   * contexte llama.cpp (`contexte.saveSession(filepath, {tokenSize})`) — vérifiée
   * dans dist/esm/index.js. Optionnelle : une version du plugin qui ne l'a pas
   * laisse le moteur fonctionner sans cache.
   */
  saveSession?: (filepath: string) => Promise<unknown>;
  /** Recharge l'état précédemment sauvé (`contexte.loadSession(filepath)`). */
  loadSession?: (filepath: string) => Promise<unknown>;
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
  /**
   * Taille du contexte en jetons. 4096 par défaut : un agent reçoit des
   * résultats d'outils (code, erreurs, HTML) en plus du prompt système, et 2048
   * débordait. Configurable pour un appareil à court de RAM.
   */
  nCtx?: number;
  /**
   * Jetons traités par lot de pré-remplissage. Plus grand = GPU mieux rempli au
   * pré-remplissage (le « prompt processing », le vrai coût du premier pas).
   * Monté à 512 contre 256 avant ; c'est un compromis mémoire/rapidité.
   */
  nBatch?: number;
  /**
   * Micro-lot logique à l'intérieur d'un lot (doit rester ≤ nBatch côté
   * llama.cpp). Aligné sur nBatch pour un seul micro-lot : le GPU travaille en
   * une passe plutôt que découpé.
   */
  nUbatch?: number;
  /**
   * Chemin d'un fichier où mettre en cache l'état du prompt (« cached prompt &
   * completion state »). ABSENT PAR DÉFAUT : le cache n'est activé que si
   * l'appelant fournit un chemin réellement inscriptible sur l'appareil.
   */
  cheminCache?: string;
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
  /**
   * Vrai si le cache d'état du prompt est ACTIF et a déjà été sauvé au moins
   * une fois. Faux tant qu'aucun `cheminCache` n'est fourni.
   */
  cacheSauve: () => boolean;
};

/**
 * Construit le moteur natif. Tout ce qui touche au matériel est injecté, donc la
 * logique est vérifiable sans téléphone.
 */
export function creerMoteurNatif(opts: OptionsNatif): MoteurNatif {
  let contexte: unknown = null;
  let charge: LocalModelId | null = null;
  let dernierTokParSeconde: number | null = null;
  // État du cache de prompt : remis à faux à chaque chargement de modèle (le
  // fichier de session ne vaut que pour le contexte qui l'a produit).
  let cacheSauve = false;
  // Passe à vrai si le cache a échoué une fois (méthode absente, fichier non
  // inscriptible…) : on n'essaie plus, plutôt que de retenter à chaque pas.
  let cacheIndisponible = false;

  return {
    nom: "natif",

    pret: () => contexte !== null,

    derniereVitesse: () => dernierTokParSeconde,

    cacheSauve: () => cacheSauve,

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
        // 4096 jetons : la boucle d'agent réinjecte le prompt système, la
        // mémoire ET les résultats d'outils (code, erreurs, HTML). À 2048, le
        // contexte débordait au milieu d'une tâche. Configurable par l'appelant.
        n_ctx: opts.nCtx ?? 4096,
        // Lots de pré-remplissage : n_batch = jetons traités par passe,
        // n_ubatch = micro-lot logique (≤ n_batch). 512/512 garde le GPU
        // correctement rempli pendant le « prompt processing » sans découper en
        // petits lots — c'est ce qui accélère le premier pas sur GPU.
        n_batch: opts.nBatch ?? 512,
        n_ubatch: opts.nUbatch ?? 512,
        n_threads: coeurs,
        // Tout déporter sur le GPU est le seul réglage qui change vraiment
        // l'ordre de grandeur de la vitesse.
        n_gpu_layers: opts.couchesGpu ?? 99,
        use_mlock: false,
      });
      charge = id;
      // Nouveau contexte : le cache de prompt de l'ancien modèle ne vaut plus.
      cacheSauve = false;
      onProgres?.({ phase: "pret", pct: 100, fichier: "", ecouleMs: Date.now() - debut });
    },

    async generer(options: GenerateOptions): Promise<string> {
      if (!contexte) throw new Error("aucun modèle natif chargé");
      const plugin = await opts.chargerPlugin();
      const prompt = gabaritQwen(options.system, options.history);
      let flux = "";

      // MISE EN CACHE DE L'ÉTAT DU PROMPT.
      // Le prompt système est identique à chaque pas de l'agent ; sans cache,
      // llama.cpp le reprojette entièrement à chaque appel. On sauve donc l'état
      // du contexte UNE FOIS (après la première génération, quand le prompt
      // système est établi et présent dans le cache KV), puis on le recharge
      // avant les pas suivants : llama.cpp réutilise le préfixe commun au lieu
      // de le recalculer. Entièrement optionnel — sans `cheminCache`, ou si le
      // plugin n'expose pas ces méthodes, rien ne change. Un échec de cache est
      // avalé : il ne doit jamais faire échouer une génération.
      const cachePossible = typeof opts.cheminCache === "string" && opts.cheminCache.length > 0;
      if (cachePossible && !cacheIndisponible && cacheSauve && typeof plugin.loadSession === "function") {
        try {
          await plugin.loadSession(opts.cheminCache as string);
        } catch {
          /* fichier absent ou illisible : on régénère depuis zéro, et on
             n'insiste plus — pas de cache plutôt qu'un échec à chaque pas */
          cacheIndisponible = true;
        }
      }

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
          // Contraintes de sortie structurée. `json_schema` (chaîne) est
          // converti en grammaire par llama.cpp ; `grammar` (GBNF) est utilisé
          // directement et prime si les deux sont fournis. Absents, le moteur
          // se comporte exactement comme avant.
          ...(options.jsonSchema ? { json_schema: options.jsonSchema } : {}),
          ...(options.grammar ? { grammar: options.grammar } : {}),
        },
        (data) => {
          if (typeof data?.token === "string") {
            flux += data.token;
            options.onToken?.(data.token);
          }
        },
      );

      // Le prompt est maintenant dans le cache KV : on sauve l'état pour que le
      // prochain pas puisse le recharger. Une seule fois par contexte chargé.
      if (cachePossible && !cacheIndisponible && !cacheSauve && typeof plugin.saveSession === "function") {
        try {
          await plugin.saveSession(opts.cheminCache as string);
          cacheSauve = true;
        } catch {
          /* pas de cache : on continue sans, la correction reste intacte */
          cacheIndisponible = true;
        }
      }

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

/** Le contexte rendu par `initLlama` : c'est LUI qui porte `completion`,
 * ainsi que `saveSession`/`loadSession` (état du prompt). */
type ContextePlugin = {
  completion?: PluginLlama["completion"];
  saveSession?: (filepath: string, options?: { tokenSize: number }) => Promise<unknown>;
  loadSession?: (filepath: string) => Promise<unknown>;
};

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
  /**
   * Chemin du fichier de cache de l'état du prompt. Laissé indéfini, le cache
   * est DÉSACTIVÉ : c'est le défaut, tant qu'aucun chemin réellement
   * inscriptible n'est fourni par l'appelant (l'appli n'a pas, à ce niveau, de
   * moyen d'obtenir un tel chemin sans le plugin Filesystem).
   */
  cheminCache?: string,
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
    // Méthodes de session : elles vivent aussi sur le contexte (vérifié dans
    // dist/esm/index.js). On ne les expose que si le contexte les a, sinon
    // `creerMoteurNatif` se contente de fonctionner sans cache.
    saveSession: async (filepath) => {
      const c = contexte;
      if (!c || typeof c.saveSession !== "function") {
        throw new Error("le contexte llama.cpp n'expose pas saveSession");
      }
      return c.saveSession(filepath);
    },
    loadSession: async (filepath) => {
      const c = contexte;
      if (!c || typeof c.loadSession !== "function") {
        throw new Error("le contexte llama.cpp n'expose pas loadSession");
      }
      return c.loadSession(filepath);
    },
  };
  const libere = mod.releaseAllLlama?.bind(mod);
  if (libere) adaptateur.releaseAllLlama = () => libere();

  return creerMoteurNatif({ cheminModele, asset, cheminCache, chargerPlugin: async () => adaptateur });
}
