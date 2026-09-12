/**
 * Moteur NATIF — llama.cpp dans l'APK. C'est le SEUL moteur d'inférence du
 * projet depuis le retrait du moteur navigateur (WebGPU / transformers.js).
 *
 * Pourquoi le natif s'impose : une WebView Android n'expose pas WebGPU, donc
 * l'appli retombait sur du WebAssembly mono-thread — mesuré à **1,4 tok/s** sur
 * le téléphone, contre 5 dans Chrome. Le moteur natif utilise la RAM réelle de
 * l'appareil (12 Go ici).
 *
 * CE QU'IL N'APPORTE PAS — trois croyances corrigées, chacune adossée à une
 * preuve lue dans le plugin installé (llama-cpp-capacitor 0.1.5) :
 *
 *  1. AUCUN déport GPU. Le `.so` livré ne contient ni backend OpenCL ni backend
 *     Vulkan, et `llama-model.cpp:1965-1971` force `act_gpu_layers = 0` quand la
 *     liste de devices est vide. `n_gpu_layers` est donc SANS EFFET : il n'est
 *     plus transmis. Le commentaire qui le présentait comme « le seul réglage
 *     qui change vraiment l'ordre de grandeur » était faux. La vraie
 *     accélération est celle des noyaux ARM (dotprod / i8mm), qui étaient dans
 *     l'arbre mais pas compilés — corrigé par le patch CMake (dossier
 *     `patches/`, appliqué par `npm install`).
 *
 *  2. AUCUN cache d'état du prompt par fichier. `saveSession`/`loadSession` de
 *     `LlamaCpp.java:801-823` ne font RIEN (corps en commentaire, aucune E/S,
 *     aucun appel JNI) et répondent pourtant un succès. Les appeler donnait un
 *     `cacheSauve = true` mensonger et un `loadSession` à chaque pas pour rien.
 *     Ce module ne les appelle plus et ne les expose plus.
 *
 *  3. LE NOMBRE DE THREADS EST MAINTENANT RÉGLABLE — et il est réglé. Ce n'était
 *     pas le cas : `jni.cpp:322-406` ne lisait que `n_ctx`, `n_batch`,
 *     `n_gpu_layers`, `use_mmap`, `use_mlock` et `embedding`, donc `n_threads`
 *     était ignoré en silence et le moteur retombait sur
 *     `LM_GGML_DEFAULT_N_THREADS = 4` (`ggml.h:228`) — 4 threads sur un
 *     téléphone 8 cœurs, quelle que soit la machine. Corrigé par le second
 *     patch natif (`patches/llama-cpp-capacitor+0.1.5+001+threads.patch`) : le
 *     JNI lit désormais `n_threads` et le nombre demandé arrive vraiment au
 *     moteur. C'est `nbThreadsCalcul()` qui choisit la valeur (voir son
 *     commentaire : la moitié des processeurs logiques, bornée).
 *     Ce qui n'a PAS changé : `n_ubatch`, `flash_attn`, `cache_type_k/v`,
 *     `n_cpu_moe`, `swa_full` et `draft_model` restent ignorés par ce lecteur
 *     JNI. Le calcul `nbCoeurs - 1` d'autrefois reste mort : personne ne lit
 *     `nbCoeurs`.
 *
 * CE QUI RESTE, ET QU'IL FAUT PROTÉGER : la réutilisation du préfixe de prompt,
 * elle, est réelle et AUTOMATIQUE. À chaque appel, `cap-completion.cpp:178`
 * (`n_past = common_part(embd, text_tokens)`) compare les jetons du prompt
 * précédemment évalué à ceux du nouveau prompt et ne réévalue que la queue. Cela
 * ne fonctionne que si le texte réinjecté est IDENTIQUE, jeton pour jeton, à ce
 * qui a déjà été évalué : c'est pourquoi `generer` rend le texte du moteur
 * **brut** (aucun `.trim()`, aucun `.replace()`), et pourquoi le nettoyage
 * d'affichage vit à part, dans `nettoyerPourAffichage`.
 *
 * Les modèles sont des GGUF, en quantifications agressives. Point clé, appris en
 * lisant les chiffres : en génération le coût dépend des octets LUS PAR JETON,
 * pas du nombre de paramètres. Un dense 8B en Q4 lit ~5 Go par jeton ; un modèle
 * à experts (MoE) de 30B n'en lit que ~1,3 Go parce qu'il n'active que 3B à la
 * fois. D'où la présence du 30B-A3B quantifié à l'extrême dans la liste : quatre
 * fois plus gros, plus rapide.
 *
 * Le module n'importe PAS le plugin : on le lui passe. C'est ce qui permet de le
 * tester sans Android, avec un simulacre.
 */
import type { GenerateOptions, LocalModelId, ProgresChargement } from "./types.ts";
import type { Moteur } from "./moteur.ts";

export type ModeleGguf = {
  /** Identifiant local, aligné sur `MODELS` (lib/edge0.ts). */
  id: LocalModelId;
  nom: string;
  court: string;
  /** Fichier GGUF attendu sur l'appareil. */
  fichier: string;
  /** Taille RÉELLE du fichier, relevée sur l'API du Hub (Go). */
  tailleGo: number;
  /**
   * Taille EXACTE en octets, relevée sur le Hub (`x-linked-size` de l'en-tête
   * HTTP). Sert à VÉRIFIER un téléchargement : un fichier tronqué ou un mauvais
   * fichier doit être refusé, pas chargé. Pour le 0.5B Q4_K_M il vaut
   * 397 808 288 octets.
   */
  octets: number;
  /**
   * Adresse de téléchargement directe du GGUF (fichier public sur le Hugging
   * Face Hub). Vérifiée : la taille annoncée par l'en-tête `content-length`
   * correspond bien à `octets`.
   */
  url: string;
  /** Octets lus par jeton, en Q4 : ce qui décide vraiment de la vitesse. */
  lectureGoParJeton: number;
  note: string;
};

/**
 * Tailles MESURÉES sur le Hub (pas estimées). Les deux premiers sont des denses,
 * le dernier est la réponse au problème de vitesse : à experts, gros mais peu lu
 * à chaque jeton.
 */
export const MODELES_GGUF: readonly ModeleGguf[] = [
  {
    id: "coder05",
    nom: "Qwen2.5-Coder-0.5B-Instruct (Q4_K_M)",
    court: "0.5B Q4",
    fichier: "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
    tailleGo: 0.398,
    octets: 397_808_288,
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
    lectureGoParJeton: 0.4,
    note: "Le plus léger. Sert à prouver que la chaîne native fonctionne.",
  },
  {
    id: "coder15",
    nom: "Qwen2.5-Coder-1.5B-Instruct (Q4_K_M)",
    court: "1.5B Q4",
    fichier: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
    tailleGo: 0.986,
    octets: 986_048_800,
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
    lectureGoParJeton: 1.0,
    note: "Bon compromis sur un téléphone récent, et fiable pour les outils.",
  },
  {
    id: "coder3b",
    nom: "Qwen3-Coder-30B-A3B-Instruct (UD-TQ1_0, 1 bit)",
    court: "30B-A3B 1 bit",
    // Nom EXACT du fichier dans le dépôt unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF
    // (vérifié sur l'API du Hub). RETOUR à UD-TQ1_0 après un essai UD-IQ1_S :
    // 8,005 Go contre 8,914 Go, et ces 0,9 Go comptent — la KV (4096 jetons), les
    // buffers de calcul et l'OS ne tiennent pas dans les 12 Go de l'appareil avec
    // IQ1_S (débordement = tué par le système, pas « juste plus lent »).
    // AUTRE PISTE, mesurée sur le Hub : ERNIE-4.5-21B-A3B-PT-UD-IQ2_M
    // (unsloth/ERNIE-4.5-21B-A3B-PT-GGUF, 8 025 599 776 octets = 8,026 Go,
    // 2 bits au lieu de 1) — architecture « ernie4_5-moe », bien présente dans
    // la table de chargement (llama-arch.cpp:87), donc chargeable par ce binaire.
    // Même budget mémoire, quantification plus fine : à essayer avant IQ1_S.
    fichier: "Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf",
    tailleGo: 8.005,
    octets: 8_005_213_344,
    url: "https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf",
    lectureGoParJeton: 1.3,
    note: "Le pari : 30B de connaissances, 3B activés, donc peu d'octets lus par jeton — plus rapide qu'un dense 8B malgré quatre fois plus de poids. 8,0 Go sur douze : il reste de quoi tenir la KV et les buffers. La fiabilité des appels d'outils à 1 bit reste à prouver.",
  },
];

export function modeleGguf(id: LocalModelId): ModeleGguf {
  return MODELES_GGUF.find((m) => m.id === id) ?? MODELES_GGUF[1];
}

/**
 * Processeurs logiques vus par la WebView. `navigator.hardwareConcurrency`
 * existe dans toute WebView Android moderne ; le repli à 4 n'est atteint que
 * dans un environnement sans `navigator` (tests Node, rendu serveur).
 */
function nbProcesseursLogiques(): number {
  const n = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

/**
 * Nombre de threads de CALCUL à demander au moteur, pour un processeur
 * hétérogène (big.LITTLE).
 *
 * POURQUOI PAS TOUS LES CŒURS : ggml découpe le travail d'une étape de graphe en
 * `n_threads` parts et attend TOUS ses threads à la barrière de fin d'étape
 * (`lm_ggml_graph_compute_kickoff` / `lm_ggml_graph_compute_thread`,
 * `ggml-cpu.c`). Une étape ne peut donc pas aller plus vite que son thread le
 * plus lent : un seul thread qui atterrit sur un petit cœur — ou qui se fait
 * préempter dessus — ralentit l'étape ENTIÈRE. Sur un big.LITTLE, demander
 * `hardwareConcurrency` revient à garantir que des threads tournent sur les
 * petits cœurs, donc à payer la barrière pour rien.
 *
 * LA RÈGLE, ET POURQUOI ELLE : la moitié des processeurs logiques. Sur les
 * topologies réelles (1+3+4, 2+6, 4+4 — tous les 8 cœurs de téléphone), la
 * moitié EST la taille du cluster de performance. C'est aussi exactement la
 * règle de repli que llama.cpp s'applique à lui-même quand il ne sait pas
 * compter les cœurs « math » : `n <= 4 ? n : n / 2` (`common.cpp:126-127`, et
 * `:100` côté Windows). On ne réinvente donc rien, on applique la même formule
 * là où elle est utile — dans l'appli, qui connaît `hardwareConcurrency`.
 *
 * BORNES : au moins 1 (un appareil mono-cœur doit rester utilisable) et au plus
 * 6 (sur les 12 cœurs et plus, garder des cœurs pour la WebView, le fil
 * d'affichage et l'OS évite que l'appli entière se fige pendant que le moteur
 * calcule ; au-delà de 6, le gain mesuré sur téléphone ne compense plus ce coût).
 *
 * CE QUE ÇA DONNE ICI : sur le téléphone 8 cœurs visé, la formule tombe sur 4 —
 * le même NOMBRE que la constante 4 qui s'appliquait par accident. Ce n'est pas
 * un hasard : c'est la taille du cluster de performance. Ce qui change vraiment,
 * c'est que ce 4 est désormais CHOISI, TRANSMIS et honoré (avant, le réglage
 * était ignoré en silence), qu'il suit le SoC (6 sur 12 cœurs), et qu'il
 * s'accompagne d'un pool de threads PERSISTANT côté natif au lieu d'un pool
 * recréé à chaque graphe calculé — donc à chaque jeton.
 *
 * Le natif applique la même règle en repli (`nb_threads_par_defaut`, `jni.cpp`)
 * pour le cas où l'appelant n'envoie rien : les deux moitiés ne peuvent pas
 * diverger.
 */
export function nbThreadsCalcul(logiques: number = nbProcesseursLogiques()): number {
  const n = Number.isFinite(logiques) && logiques >= 1 ? Math.floor(logiques) : 4;
  // ≤ 4 : il n'y a pas de cluster de performance à isoler (et c'est la règle de
  // llama.cpp lui-même). Au-delà : la moitié.
  const base = n <= 4 ? n : Math.floor(n / 2);
  return Math.min(Math.max(base, 1), 6);
}

/**
 * Ce qu'on attend du plugin, et rien de plus (donc simulable).
 *
 * PAS de `saveSession`/`loadSession` ici : dans la version installée (0.1.5),
 * `LlamaCpp.java:801-823` les implémente en... ne faisant rien, tout en
 * répondant un succès. Les inclure au contrat laissait croire à un cache d'état
 * du prompt qui n'existe pas. Le jour où un plugin les implémentera vraiment,
 * elles reviendront — avec un vrai test de bout en bout.
 */
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
  /** Charge le plugin (import dynamique en vrai, simulacre dans les tests). */
  chargerPlugin: () => Promise<PluginLlama>;
  /**
   * Taille du contexte en jetons. 4096 par défaut : un agent reçoit des
   * résultats d'outils (code, erreurs, HTML) en plus du prompt système, et 2048
   * débordait. Configurable pour un appareil à court de RAM.
   * RÉELLEMENT lu par le natif (`jni.cpp`, clé « n_ctx »).
   */
  nCtx?: number;
  /**
   * Jetons traités par lot de pré-remplissage (« prompt processing »).
   * RÉELLEMENT lu par le natif (clé « n_batch »). 512 par défaut.
   *
   * `n_ubatch` n'a PLUS d'entrée ici : elle est absente du lecteur JNI de la
   * version 0.1.5, donc l'envoyer ne servait à rien — et le commentaire qui
   * prétendait qu'elle « remplissait mieux le GPU » était doublement faux
   * (aucun GPU, et paramètre ignoré).
   */
  nBatch?: number;
  /**
   * Threads de CALCUL. Défaut : `nbThreadsCalcul()`, c'est-à-dire la taille
   * estimée du cluster de performance (la moitié des processeurs logiques,
   * bornée à [1, 6]). Surchargeable pour mesurer une autre valeur sur appareil.
   *
   * RÉELLEMENT transmis au moteur depuis le patch natif
   * `patches/llama-cpp-capacitor+0.1.5+001+threads.patch` (le JNI lit la clé
   * `n_threads`). Sans ce patch, la clé est ignorée en silence et le moteur
   * reste à 4 threads (`ggml.h:228`) : l'envoyer n'est jamais une erreur, au
   * pire c'est sans effet.
   */
  nThreads?: number;
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
 * Nettoyage d'AFFICHAGE — balises de conversation retirées, bords rognés.
 *
 * À N'APPLIQUER QU'À ce qui part à l'écran (ou à un `history` humain) : ce que
 * `generer` rend reste BRUT, parce que la réutilisation du cache KV
 * (`cap-completion.cpp:178`) compare le prompt précédent au nouveau JETON PAR
 * JETON. Rogner ici ce qu'on réinjecte là-bas suffit à faire diverger le
 * préfixe, donc à recalculer ce qui était déjà évalué.
 */
export function nettoyerPourAffichage(brut: string): string {
  return brut.replace(/<\|im_(end|start)\|>/g, "").trim();
}

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

    // Défaut aligné sur celui du store (`session.ts`) : le 0,5B. Ce repli n'est
    // atteint que si un contexte existe — auquel cas `charge` est toujours
    // défini ; il n'écrase donc jamais un choix réel de l'utilisateur.
    modeleCharge: () => (contexte === null ? null : opts.cheminModele(modeleGguf(charge ?? "coder05"))),

    async charger(id: LocalModelId, onProgres?: (p: ProgresChargement) => void): Promise<void> {
      const debut = Date.now();
      if (contexte && charge === id) return;

      const plugin = await opts.chargerPlugin();
      const modele = modeleGguf(id);
      const chemin = opts.cheminModele(modele);

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
        // NOM DE FICHIER SEUL. Sur Android, `LlamaCpp.initContext` ne retient du
        // chemin que `new File(modelPath).getName()`, puis cherche ce nom dans
        // ses propres dossiers : getFilesDir()/<nom>, getFilesDir()/Documents/<nom>,
        // getExternalFilesDir(null)/<nom>, /sdcard/Documents/<nom>, etc. L'appli
        // pose donc le GGUF dans getFilesDir()/Documents (voir modeleLocal.ts) et
        // passe ici le seul nom de fichier. On n'envoie PLUS `is_model_asset` :
        // le TypeScript du plugin le transmet, mais le code Android ne le lit
        // nulle part (vérifié dans LlamaCpp.java) — il était purement ignoré.
        model: chemin,
        // 4096 jetons : la boucle d'agent réinjecte le prompt système, la
        // mémoire ET les résultats d'outils (code, erreurs, HTML). À 2048, le
        // contexte débordait au milieu d'une tâche. Configurable par l'appelant.
        n_ctx: opts.nCtx ?? 4096,
        // Lots de pré-remplissage : jetons traités par passe. C'est le SEUL
        // levier de vitesse de chargement réellement lu par le natif, et il
        // compte davantage maintenant que les noyaux dotprod/i8mm sont compilés.
        n_batch: opts.nBatch ?? 512,
        // PAS de `n_gpu_layers` : le binaire du plugin ne contient aucun backend
        // GPU (ni OpenCL ni Vulkan) et llama-model.cpp:1965-1971 met
        // `act_gpu_layers = 0` quand la liste de devices est vide. L'envoyer ne
        // déplaçait pas une seule couche — c'était un réglage décoratif.
        //
        // `n_threads` : RÉELLEMENT lu par le natif depuis le second patch
        // (`patches/llama-cpp-capacitor+0.1.5+001+threads.patch`, jni.cpp :
        // « Extract n_threads »). La valeur vient de `nbThreadsCalcul()` — la
        // moitié des processeurs logiques, bornée à [1, 6] — parce que ggml
        // attend TOUS ses threads à la barrière de fin d'étape : un thread sur
        // un petit cœur ralentit l'étape entière. Le défaut natif, si on
        // n'envoyait rien, applique exactement la même règle.
        n_threads: opts.nThreads ?? nbThreadsCalcul(),
        // use_mmap: false — sur téléphone, le coût de la projection mémoire et
        // des défauts de page pendant le pré-remplissage pèse plus lourd que le
        // gain de RAM : le chargement va plus vite jusqu'au premier jeton. C'est
        // ce que mesurent les retours de terrain sur ce plugin ; c'est aussi ce
        // qui ramène le modèle entièrement en RAM, cohérent avec le choix de
        // quant à 8,0 Go.
        use_mmap: false,
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

      // llama.cpp rend la vitesse qu'il a MESURÉE : on la remonte telle quelle,
      // au lieu de l'estimer à partir d'une longueur de texte.
      const mesure = resultat?.timings?.predicted_per_second;
      if (typeof mesure === "number" && mesure > 0) {
        dernierTokParSeconde = mesure;
        const jetons = Math.round(flux.length / 4);
        options.onVitesse?.(mesure, jetons, 0);
      }

      // LE TEXTE EST RENDU TEL QUEL — c'est la seule forme qui laisse le
      // préfixe réutilisable. Un simple `.trim()` ici suffit à casser
      // `common_part` au pas suivant : les jetons du préfixe ne correspondent
      // plus, et tout ce qui suit est réévalué. Le nettoyage d'affichage
      // (`nettoyerPourAffichage`) est l'affaire de l'appelant, PAS d'ici.
      return flux || resultat?.text || "";
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
type ContextePlugin = {
  completion?: PluginLlama["completion"];
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
   * Où trouver le GGUF. En pratique on lui passe `cheminModele(id)` de
   * `modeleLocal.ts`, c'est-à-dire le NOM DE FICHIER SEUL : le plugin Android le
   * résout dans getFilesDir()/Documents/<fichier>, l'endroit où l'appli l'a
   * téléchargé.
   */
  cheminModele: (m: ModeleGguf) => string,
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

  return creerMoteurNatif({ cheminModele, chargerPlugin: async () => adaptateur });
}
