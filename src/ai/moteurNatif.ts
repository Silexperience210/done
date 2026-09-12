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
 * LA TRACE, ÉCRITE AVANT CHAQUE ÉTAPE (voir `journal.ts`) : ce module écrit dans
 * un fichier lisible sur le téléphone — pas seulement dans la console — le
 * chemin résolu du modèle, la présence et la taille du fichier, le début et la
 * fin de la lecture/initialisation, le début du premier calcul, le premier jeton
 * et la fin de génération, plus toute erreur dans son texte intégral. La raison
 * est mécanique : la ligne est écrite AVANT l'étape, donc si une étape ne rend
 * jamais la main, la dernière ligne du fichier la nomme. Un journal écrit après
 * coup serait muet au moment précis où il servirait.
 *
 * DEUX RÉGLAGES DU MOTEUR ONT ÉTÉ CORRIGÉS ICI, et il ne faut pas les remettre :
 *  - `use_mmap: false` a été retiré (retour au défaut `true`). Il forçait la
 *    lecture COMPLÈTE du GGUF en mémoire vive avant que le contexte existe — sur
 *    un téléphone contraint, c'est un pic d'allocation qui peut faire échanger
 *    de la mémoire au lieu d'avancer. Aucun gain n'avait été mesuré ;
 *  - le « pool de threads persistant » du patch C++ a été retiré, pour la même
 *    raison : jamais mesuré, sans effet sur le nombre de threads de l'appareil,
 *    et un attachement de pool mal formé peut bloquer ggml sans erreur.
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
 *
 * CE QUE LE NATIF ANDROID NE DONNE PAS — et qui a fait afficher « 0.0 tok/s »
 * pendant que le moteur tournait : la réponse de `completion` ne contient AUCUN
 * débit. `jni.cpp:986-997` ne remplit `timings` qu'avec `prompt_n` et
 * `predicted_n` (« Add timing information (basic) ») ; `predicted_per_second`
 * n'existe que côté iOS (`LlamaCpp.swift:406`) et dans les définitions
 * partagées. Le compte de jetons, lui, est réel et présent sur Android
 * (`tokens_predicted`, jni.cpp:948) : c'est sur LUI que repose la mesure, la
 * durée étant relevée dans l'appli. Les détails et l'ordre de priorité sont
 * dans `debitMesure`.
 */
import type { GenerateOptions, LocalModelId, ProgresChargement } from "./types.ts";
import type { Moteur } from "./moteur.ts";
// La TRACE, écrite AVANT chaque étape (voir journal.ts). Module volontairement
// sans dépendance native : il n'importe Capacitor qu'à l'appel, donc ce fichier
// reste chargeable dans un navigateur et dans les tests Node.
import { journaliser, noter, texteErreurComplete } from "./journal.ts";
// Type SEULEMENT : `modeleLocal.ts` importe `modeleGguf` d'ici, et un import de
// valeur créerait un cycle. `import type` disparaît à la compilation.
import type { EtatFichierModele } from "./modeleLocal.ts";

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
  // Repli = le modèle de DÉMARRAGE, celui dont `MODELES_GGUF[0]` est la
  // définition : le 0.5B, le seul que la chaîne native peut charger sans risque
  // mémoire. Le repli précédent (`MODELES_GGUF[1]`, le 1.5B) faisait charger un
  // modèle plus gros que celui annoncé à l'écran dès qu'un identifiant ne
  // correspondait à rien — l'inverse de ce que le repli doit faire.
  return MODELES_GGUF.find((m) => m.id === id) ?? MODELES_GGUF[0];
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
 * c'est que ce 4 est désormais CHOISI et TRANSMIS (avant, le réglage était
 * ignoré en silence) et qu'il suit le SoC (6 sur 12 cœurs).
 *
 * CE QUI NE VA PAS AVEC : un « pool de threads persistant » côté natif a été
 * essayé, puis RETIRÉ. Il n'a jamais été mesuré, il ne changeait rien au nombre
 * de threads sur l'appareil visé (4 dans les deux cas), et un pool attaché de
 * travers peut faire attendre ggml indéfiniment à sa barrière de fin d'étape —
 * c'est-à-dire bloquer le chargement ou le calcul sans erreur ni journal. Voir
 * l'en-tête de `patches/llama-cpp-capacitor+0.1.5+001+threads.patch`. Le pool
 * jetable recréé par ggml est le comportement PAR DÉFAUT de llama.cpp : plus
 * lent à la marge, jamais bloquant. Ce choix-là se reprend avec un chronomètre,
 * pas avec une hypothèse.
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
 * Ce qu'une RÉPONSE de completion peut porter — forme réelle du plugin, pas
 * forme rêvée (voir `debitMesure` pour ce qui arrive vraiment sur Android).
 */
export type ReponseCompletion = {
  text?: string;
  content?: string;
  /**
   * COMPTEUR RÉEL de jetons générés. Présent sur Android
   * (`jni.cpp:948`, clé `tokens_predicted`) ET sur iOS. C'est la seule donnée
   * de débit réellement exploitable en production.
   */
  tokens_predicted?: number;
  tokens_evaluated?: number;
  /**
   * Bloc de mesure du moteur. Sur Android il ne contient QUE `prompt_n` et
   * `predicted_n` (`jni.cpp:986-997`) ; les champs de débit et de durée
   * n'existent que côté iOS (`LlamaCpp.swift:406`). On lit donc les deux
   * formes, sans présumer de la plateforme.
   */
  timings?: {
    prompt_n?: number;
    predicted_n?: number;
    predicted_ms?: number;
    predicted_per_second?: number;
  };
};

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
  ) => Promise<ReponseCompletion>;
  releaseAllLlama?: () => Promise<void>;
};

export type OptionsNatif = {
  /** Où trouver le GGUF sur l'appareil. */
  cheminModele: (m: ModeleGguf) => string;
  /** Charge le plugin (import dynamique en vrai, simulacre dans les tests). */
  chargerPlugin: () => Promise<PluginLlama>;
  /**
   * VÉRIFIE OÙ EST LE FICHIER, et sa taille, AVANT d'appeler le moteur. Injecté
   * (et non importé) pour la même raison que `cheminModele` : le moteur natif ne
   * doit dépendre ni de `@capacitor/filesystem`, ni d'un chemin en dur, pour
   * rester testable sans téléphone. En production, c'est `chercherModele` de
   * `modeleLocal.ts` — les emplacements qu'il interroge sont ceux où le natif
   * cherchera vraiment le GGUF.
   *
   * Sert au DIAGNOSTIC, pas à la décision : le moteur natif reste seul juge de
   * ce qu'il peut ouvrir. Son résultat est journalisé (`journal.ts`) pour qu'une
   * trace montre si le fichier était là, où, et de quelle taille.
   */
  verifierFichier?: (m: ModeleGguf) => Promise<EtatFichierModele>;
  /**
   * Délai maximal accordé à `verifierFichier` (défaut : `DIAGNOSTIC_MAX_MS`).
   * Configurable pour les TESTS : un diagnostic abandonné doit être vérifiable
   * sans faire durer la suite de tests quatre secondes.
   */
  delaiDiagnosticMs?: number;
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
  /**
   * Horloge en millisecondes. Injectée par les tests pour que la mesure du
   * débit soit vérifiable sans temps réel ; en production, `Date.now`.
   */
  maintenant?: () => number;
};

/**
 * Délai maximal accordé à la VÉRIFICATION du fichier (diagnostic, 4 s). C'est une
 * information, pas une condition : un `stat` qui ne rend pas la main est
 * abandonné et le chargement continue. Sans ce plafond, le diagnostic pourrait
 * devenir la panne qu'il est censé décrire.
 */
export const DIAGNOSTIC_MAX_MS = 4_000;

/**
 * Rend le résultat de `p`, ou `null` s'il n'arrive pas dans `ms`. Le rejet
 * éventuel de `p` APRÈS l'expiration est apprivoisé ici, pour ne pas finir en
 * « unhandled rejection » (même précaution que dans `telechargerModele`).
 */
async function avecDelai<T>(p: Promise<T>, ms: number): Promise<T | null> {
  p.catch(() => {});
  let minuteur: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resoudre) => {
        minuteur = setTimeout(() => resoudre(null), ms);
      }),
    ]);
  } finally {
    if (minuteur !== null) clearTimeout(minuteur);
  }
}

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
 * sens qu'en natif (débit réellement mesuré, modèle réellement chargé).
 */
export type MoteurNatif = Moteur & {
  /**
   * Débit du dernier appel, en tok/s — `null` tant qu'aucune génération n'a
   * livré de quoi le calculer. Sur Android la valeur est le COUNT de jetons du
   * moteur divisé par la fenêtre de décodage mesurée ici (voir `debitMesure`) :
   * ce n'est donc pas un chiffre sorti de llama.cpp, et l'interface ne doit pas
   * le présenter comme tel.
   */
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

/** Débit retenu pour une génération, avec de quoi l'afficher sans mentir. */
export type MesureDebit = {
  /** Débit retenu, en jetons par seconde. TOUJOURS strictement positif. */
  tokParSeconde: number;
  /** Compte de jetons RÉEL du moteur ; 0 quand il ne le fournit pas. */
  jetons: number;
  /** Durée du décodage retenue, en millisecondes (0 si inconnue). */
  msDepuisPremier: number;
};

/** Un nombre exploitable strictement positif, ou `null`. Jamais 0, jamais NaN. */
function nombrePositif(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * LA MESURE DE DÉBIT — et ce que le natif Android donne VRAIMENT.
 *
 * FAIT ÉTABLI, lu dans le paquet installé (llama-cpp-capacitor 0.1.5) et pas
 * supposé : sur ANDROID, la réponse de `completion` ne porte PAS
 * `predicted_per_second`. `android/src/main/jni.cpp:986-997` construit l'objet
 * `timings` avec deux clés, et deux seulement — `prompt_n` et `predicted_n` —
 * sous un commentaire qui dit lui-même « Add timing information (basic) ».
 * `predicted_per_second`, `predicted_ms` et `prompt_per_second` n'existent que
 * dans l'implémentation iOS (`ios/Sources/LlamaCppPlugin/LlamaCpp.swift:406`) et
 * dans `definitions.d.ts`, qui décrit l'union des deux plateformes. L'ancien
 * code attendait donc un champ que la plateforme de PRODUCTION ne produit
 * jamais : la vitesse restait indéfinie et l'écran affichait « 0.0 tok/s »
 * alors que le moteur tournait.
 *
 * CE QUI EST DISPONIBLE, ET QUI SUFFIT : le NOMBRE DE JETONS GÉNÉRÉS, réel, en
 * deux endroits (`tokens_predicted`, jni.cpp:948, et `timings.predicted_n`,
 * jni.cpp:992) — présent sur Android comme sur iOS. On divise donc un COMPTE DE
 * JETONS RÉEL par une FENÊTRE DE DÉCODAGE MESURÉE sur l'appareil. Rien n'est
 * déduit d'une longueur de texte : plus de `flux.length / 4`.
 *
 * Ordre de priorité, et il est volontaire :
 *  1. `timings.predicted_per_second` — le débit du moteur, pris TEL QUEL quand
 *     il existe (iOS, ou une future version Android). C'est toujours lui qui
 *     gagne.
 *  2. jetons réels ÷ durée mesurée — le cas Android. La durée vient du moteur
 *     (`predicted_ms`) si elle existe, sinon de la fenêtre relevée ici entre le
 *     premier jeton et la fin de l'appel : après le premier jeton, le moteur ne
 *     fait QUE décoder, le pré-remplissage est derrière. On sous-estime donc
 *     plutôt que de surestimer (à défaut de premier jeton, on retombe sur la
 *     durée totale de l'appel, qui inclut le pré-remplissage).
 *  3. Sinon `null` : on n'invente RIEN. Un `null` se voit à l'écran (« — »),
 *     un 0 fabriqué se fait passer pour une mesure.
 */
export function debitMesure(
  reponse: ReponseCompletion | null | undefined,
  fenetre: { msDepuisPremierJeton: number; msTotal: number },
): MesureDebit | null {
  const timings = reponse?.timings;
  const jetons = nombrePositif(timings?.predicted_n) ?? nombrePositif(reponse?.tokens_predicted);
  const dureeMs =
    nombrePositif(timings?.predicted_ms) ??
    nombrePositif(fenetre.msDepuisPremierJeton) ??
    nombrePositif(fenetre.msTotal);

  // 1) Le moteur a mesuré lui-même : sa valeur passe, sans retouche.
  const donnee = nombrePositif(timings?.predicted_per_second);
  if (donnee !== null) {
    return {
      tokParSeconde: donnee,
      jetons: jetons ?? 0,
      msDepuisPremier: dureeMs === null ? 0 : Math.round(dureeMs),
    };
  }

  // 2) Compte de jetons réel ÷ fenêtre mesurée.
  if (jetons === null || dureeMs === null) return null;
  const taux = jetons / (dureeMs / 1000);
  if (!Number.isFinite(taux) || taux <= 0) return null;
  return { tokParSeconde: taux, jetons, msDepuisPremier: Math.round(dureeMs) };
}

/**
 * Construit le moteur natif. Tout ce qui touche au matériel est injecté, donc la
 * logique est vérifiable sans téléphone.
 */
export function creerMoteurNatif(opts: OptionsNatif): MoteurNatif {
  let contexte: unknown = null;
  let charge: LocalModelId | null = null;
  let dernierTokParSeconde: number | null = null;
  /** Nombre d'appels de `generer` : distingue le PREMIER calcul des suivants. */
  let generations = 0;

  /**
   * DEMANDE OÙ EST LE FICHIER, ET LE TRACE. Jamais fatal : cette vérification
   * est un diagnostic, pas une condition. Si elle ne peut pas répondre, on
   * l'écrit — c'est déjà une information (« on n'a pas pu savoir ») — et le
   * moteur natif reste seul juge.
   *
   * On écrit AUSSI la taille attendue à côté de la taille vue : c'est ce qui
   * permet de reconnaître d'un coup d'œil un fichier tronqué (téléchargement
   * interrompu), qu'aucun message du moteur ne distingue d'un fichier absent.
   */
  async function verifierEtTracer(modele: ModeleGguf): Promise<void> {
    if (!opts.verifierFichier) {
      await journaliser(
        "vérification du fichier non branchée ici : le moteur natif jugera lui-même de sa présence",
      );
      return;
    }
    try {
      // AVEC UN PLAFOND : la vérification est un diagnostic, jamais une
      // condition. Un `stat` qui ne répond pas ne doit pas retenir le
      // chargement — sinon le journal deviendrait la panne qu'il décrit.
      const delaiDiagnostic = opts.delaiDiagnosticMs ?? DIAGNOSTIC_MAX_MS;
      const etat = await avecDelai(opts.verifierFichier(modele), delaiDiagnostic);
      if (etat === null) {
        await journaliser(
          `vérification du fichier ABANDONNÉE (aucun retour en ${delaiDiagnostic} ms) : ` +
            "le chargement continue sans cette information",
        );
        return;
      }
      if (etat.trouves.length === 0) {
        // Ce n'est PAS forcément une erreur : le natif visite d'autres
        // emplacements que ceux-ci. Mais c'est exactement ce qu'il faut lire
        // quand le message final est « Failed to initialize native context ».
        await journaliser(
          `fichier jamais trouvé aux emplacements vérifiés : ${etat.emplacements
            .map((e) => `${e.chemin}${e.erreur ? ` (${e.erreur})` : ""}`)
            .join(" | ")}`,
        );
        return;
      }
      for (const trouve of etat.trouves) {
        await journaliser(
          `fichier trouvé : ${trouve.chemin} — ${trouve.octets} octets ` +
            `(taille attendue ${modele.octets} octets)`,
        );
      }
    } catch (e) {
      await journaliser(`vérification du fichier impossible : ${texteErreurComplete(e)}`);
    }
  }

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
      if (contexte && charge === id) {
        await journaliser(`chargement ignoré : « ${id} » est déjà chargé`);
        return;
      }

      // CHAQUE LIGNE EST ÉCRITE (et attendue) AVANT l'étape qu'elle annonce.
      // C'est tout l'intérêt : si une étape ne rend jamais la main, la dernière
      // ligne du fichier la nomme. Une ligne écrite après coup ne serait jamais
      // écrite dans ce cas-là.
      await journaliser(`── chargement demandé : « ${id} » (${modeleGguf(id).nom})`);

      const plugin = await opts.chargerPlugin();
      await journaliser("plugin llama.cpp chargé (import dynamique)");

      const modele = modeleGguf(id);
      const chemin = opts.cheminModele(modele);
      // CHEMIN RÉSOLU, tel qu'il partira au moteur. Sur Android, le plugin n'en
      // retient que le nom de fichier et le cherche dans ses propres dossiers :
      // cette ligne dit donc exactement ce que le moteur va chercher.
      await journaliser(`chemin du modèle transmis au moteur : ${chemin}`);

      // 1) OÙ EST LE FICHIER, ET DE QUELLE TAILLE. Deux choses différentes :
      //    « le fichier n'est pas là où on croit » et « le fichier est là mais
      //    le moteur se bloque » ne se diagnostiquent pas pareil.
      onProgres?.({
        phase: "initialisation",
        etape: "recherche_modele",
        pct: 100,
        fichier: `${modele.court} → mémoire`,
        ecouleMs: Date.now() - debut,
      });
      await verifierEtTracer(modele);

      if (contexte && charge && charge !== id) {
        await journaliser(`libération du modèle précédent (« ${charge} ») avant de charger « ${id} »`);
        await plugin.releaseAllLlama?.();
        contexte = null;
      }

      // 2) LECTURE + INITIALISATION. Un seul appel natif, indivisible depuis
      //    ici : on le nomme exactement comme ça à l'écran, et on ne fait pas
      //    croire à deux étapes séparées.
      onProgres?.({
        phase: "initialisation",
        etape: "initialisation_moteur",
        pct: 100,
        fichier: `${modele.court} → mémoire`,
        ecouleMs: Date.now() - debut,
      });
      await journaliser(
        `début de la lecture du modèle et de l'initialisation du moteur (${modele.fichier})`,
      );

      // REPÈRE ANTI-CONFUSION : si l'initialisation dépasse une minute, on écrit
      // une ligne de plus — l'application est VIVANTE et toujours sur la MÊME
      // étape. Ce n'est pas une estimation de durée (« ça devrait prendre N s »),
      // seulement le constat de ce qui dure. La veille est arrêtée dès que
      // l'appel rend la main.
      const debutInit = Date.now();
      let veille: ReturnType<typeof setInterval> | null = setInterval(() => {
        noter(
          `toujours en cours : lecture + initialisation du moteur depuis ` +
            `${Math.round((Date.now() - debutInit) / 1000)} s (constat, pas une estimation)`,
        );
      }, 60_000);
      // `unref` QUAND IL EXISTE (Node, donc les tests) : ce minuteur ne doit
      // JAMAIS retenir à lui seul le processus en vie. Dans la WebView — le cas
      // réel — la méthode n'existe pas et le minuteur continue simplement de
      // tourner : c'est même ce qu'on veut, il écrira « toujours en cours »
      // toutes les minutes tant que l'étape dure, sans jamais l'interrompre.
      (veille as unknown as { unref?: () => void }).unref?.();

      try {
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
          // use_mmap: true — LE MAPPAGE MÉMOIRE EST RÉTABLI, et c'est le DÉFAUT
          // de llama.cpp (`common_params::use_mmap = true`, common.h:383 ; le
          // JNI du plugin écrit la même valeur, jni.cpp:265). On ne l'envoie
          // « que » pour qu'un lecteur de ce fichier ne se demande pas ce qui a
          // été décidé.
          //
          // POURQUOI ON N'ÉCRIT PLUS `false` (l'erreur qui a été commise, et
          // corrigée) : `use_mmap: false` fait LIRE les 398 Mo (ou 8 Go pour le
          // 30B) en mémoire vive AVANT que le contexte existe. Sur un téléphone
          // déjà chargé, c'est une allocation massive qui peut se mettre à
          // échanger de la mémoire (thrashing) au lieu d'avancer — exactement le
          // « ça rame sans finir » qu'on cherche à supprimer. Avec mmap, le
          // système projette le fichier et n'amène les pages qu'à la demande :
          // le chargement rend la main vite, et le coût se paie au fil des
          // jetons, sans pic d'allocation. Le « gain » annoncé (charger plus vite
          // jusqu'au premier jeton) n'a jamais été mesuré sur l'appareil — et il
          // ne peut pas compenser un blocage.
          use_mmap: true,
          // `use_mlock: false` : verrouiller les pages empêcherait l'OS de
          // récupérer de la RAM sous pression. Sur un téléphone, c'est une
          // façon sûre de se faire tuer par le système.
          use_mlock: false,
        });
        if (veille !== null) clearInterval(veille);
        veille = null;
        await journaliser("fin de l'initialisation du moteur (contexte créé)");
      } catch (e) {
        if (veille !== null) clearInterval(veille);
        veille = null;
        // L'ERREUR INTÉGRALE part dans la trace, avec sa pile quand elle existe.
        noter(`ERREUR pendant la lecture + initialisation du moteur : ${texteErreurComplete(e)}`);
        throw e;
      }

      charge = id;
      await journaliser(`chargement terminé en ${Date.now() - debut} ms`);
      onProgres?.({
        phase: "pret",
        etape: "termine",
        pct: 100,
        fichier: "",
        ecouleMs: Date.now() - debut,
      });
    },

    async generer(options: GenerateOptions): Promise<string> {
      if (!contexte) throw new Error("aucun modèle natif chargé");
      const plugin = await opts.chargerPlugin();
      const prompt = gabaritQwen(options.system, options.history);
      const maintenant = opts.maintenant ?? (() => Date.now());
      const debut = maintenant();
      let flux = "";
      // Instant du PREMIER jeton. Avant lui le moteur PRÉ-REMPLIT le prompt ;
      // après lui il ne fait plus que décoder. C'est donc à partir de là que la
      // fenêtre de décodage est honnête, et c'est cette fenêtre qu'on divise par
      // le nombre de jetons quand le moteur ne donne pas son propre débit.
      let premierJetonMs = 0;

      // L'ÉTAPE EST ANNONCÉE AVANT LE CALCUL, pas après. Le premier calcul est
      // celui qu'on guette : c'est là qu'un modèle fraîchement chargé peut
      // encore se bloquer (pré-remplissage, allocation des buffers de calcul).
      generations += 1;
      const premierCalcul = generations === 1;
      options.onEtape?.("premier_calcul");
      await journaliser(
        premierCalcul
          ? "début du PREMIER calcul (pré-remplissage du prompt, puis décodage)"
          : `début du calcul n°${generations} (${prompt.length} caractères de prompt)`,
      );

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
            if (!premierJetonMs) {
              premierJetonMs = maintenant();
              // NOTÉ, pas attendu : le premier jeton vient d'arriver, on ne
              // retarde pas l'affichage pour écrire une ligne. La file
              // d'écriture la garde dans l'ordre.
              noter(`premier jeton reçu après ${premierJetonMs - debut} ms (pré-remplissage terminé)`);
              options.onEtape?.("premier_jeton");
            }
            flux += data.token;
            options.onToken?.(data.token);
          }
        },
      );

      // LA MESURE. Le compte de jetons vient du moteur ; la fenêtre de décodage
      // est relevée ici quand le moteur ne la fournit pas (cas d'Android). Voir
      // `debitMesure` : aucun débit n'est déduit d'une longueur de texte, et
      // `null` (donc « pas de mesure ») est préféré à un chiffre inventé.
      const fin = maintenant();
      const mesure = debitMesure(resultat, {
        msDepuisPremierJeton: premierJetonMs ? fin - premierJetonMs : 0,
        msTotal: fin - debut,
      });
      if (mesure) {
        dernierTokParSeconde = mesure.tokParSeconde;
        options.onVitesse?.(mesure.tokParSeconde, mesure.jetons, mesure.msDepuisPremier);
      }

      options.onEtape?.("termine");
      await journaliser(
        mesure
          ? `fin de génération : ${mesure.jetons} jetons, ${mesure.tokParSeconde.toFixed(1)} tok/s mesurés, ` +
              `${flux.length} caractères rendus`
          : `fin de génération : débit NON MESURABLE (ni débit du moteur, ni couple ` +
              `« compte de jetons + durée » exploitable), ${flux.length} caractères rendus`,
      );

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
  /**
   * VÉRIFICATION du fichier sur le disque, à des fins de TRACE uniquement. En
   * pratique `chercherModele(id)` de `modeleLocal.ts`. Facultative : sans elle le
   * moteur fonctionne exactement pareil, la trace dit juste qu'on n'a pas
   * regardé. Elle est branchée ici plutôt qu'importée, pour que ce module ne
   * dépende pas de `@capacitor/filesystem`.
   */
  verifierFichier?: (m: ModeleGguf) => Promise<EtatFichierModele>,
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

  return creerMoteurNatif({ cheminModele, chargerPlugin: async () => adaptateur, verifierFichier });
}
