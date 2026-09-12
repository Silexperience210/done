import { create } from "zustand";
import {
  extractHtmlBlock,
  MODELS,
  newId,
  systemPrompt,
  type ChatMessage,
  type ModelId,
  type ToolEvent,
} from "@/lib/edge0";
import { estApplicationNative } from "@/ai/moteur";
import type { CheminManuel } from "@/ai/modeleLocal";
import { creerVerificateur, resumeAchevement, type EtatAchevement } from "@/ai/achevement";
import type { PasAgent } from "@/ai/agent";
import { injecterPont, type EntreeConsole } from "@/ai/pontApercu";
import type { EtatPython, ExecuteurPython } from "@/ai/pythonRunner";
import { criteresLisibles, enregistrerApp, listerApps, type AppEnregistree } from "@/ai/historique";
import {
  apercuDisponible,
  evaluerDansApercu,
  installerEcouteApercu,
  preparerVersion,
  verdictApercu,
} from "./apercu";
// RÉGLAGES DU MOTEUR (contexte, lot, threads) : réglables par l'utilisateur.
import { ecrireReglages, lireReglages, type ReglagesMoteur } from "@/ai/reglages";
import {
  libelleEtape,
  type BilanGeneration,
  type EtapeChargement,
  type GenerateOptions,
  type LocalModelId,
  type PhaseChargement,
  type ProgresChargement,
} from "@/ai/types";

/**
 * UN SEUL moteur : llama.cpp en natif, dans l'APK.
 *
 * L'inférence passe par le plugin llama-cpp-capacitor, importé dynamiquement au
 * moment du chargement — il ne doit JAMAIS être résolu par le build web, sinon
 * celui-ci casse (le plugin n'existe pas hors Android).
 *
 * Hors application native (navigateur de développement), il n'y a PAS de repli :
 * on ne fait pas semblant de faire tourner un modèle. `chargerMoteur` lève une
 * erreur explicite, que `send` traduit en message actionnable (« le modèle ne
 * tourne que dans l'appli Android ») au lieu d'échouer en silence.
 *
 * Tout le reste de `send` ne connaît que `MoteurActif` et ignore llama.cpp.
 */
type MoteurActif = {
  nom: "natif";
  charger: (id: LocalModelId, onProgres?: (p: ProgresChargement) => void) => Promise<void>;
  generer: (options: GenerateOptions) => Promise<string>;
  /**
   * Débit réel du dernier appel (tok/s), ou `null` tant qu'aucune génération n'a
   * livré de quoi le calculer. `null` est un RÉSULTAT (« pas de mesure »), pas
   * une erreur : l'interface doit l'afficher « — » et jamais « 0,0 tok/s ».
   */
  tokPerSec: () => number | null;
  /** Backend réellement utilisé, pour l'afficher sans mentir. */
  device: () => string;
  /**
   * Libère la mémoire native. Appelé quand on jette le moteur (changement de
   * réglages) : le contexte llama.cpp vit dans le processus, pas dans la WebView.
   */
  liberer: () => Promise<void>;
};

let moteur: MoteurActif | null = null;
let moteurEnCours: Promise<MoteurActif> | null = null;

/**
 * LE LANCEUR PYTHON, construit une seule fois et seulement s'il sert.
 *
 * `chargerPyodideEmbarque` va chercher Pyodide dans les ASSETS de l'APK
 * (`/pyodide/`, copié à la construction) : aucune requête sortante, et rien n'est
 * chargé tant qu'aucun script Python n'est demandé. Le module n'est importé
 * dynamiquement que pour ça : le build web reste intact.
 */
let executeurPython: (ExecuteurPython & { etat: () => EtatPython }) | null = null;
async function chargerExecuteurPython(): Promise<ExecuteurPython & { etat: () => EtatPython }> {
  if (!executeurPython) {
    const mod = await import("@/ai/pythonRunner");
    executeurPython = mod.creerExecuteurPython({ charger: mod.chargerPyodideEmbarque });
  }
  return executeurPython;
}

/**
 * Construit (ou rend) le moteur partagé de la session.
 *
 * `reglagesLive` est une FONCTION, pas une valeur : le moteur est construit une
 * fois, mais les réglages peuvent changer ensuite — auquel cas l'appelant jette
 * ce moteur (et libère sa mémoire native) puis en redemande un.
 */
function chargerMoteur(reglagesLive: () => ReglagesMoteur): Promise<MoteurActif> {
  if (moteur) return Promise.resolve(moteur);
  if (!moteurEnCours) {
    moteurEnCours = (async (): Promise<MoteurActif> => {
      if (!estApplicationNative()) {
        // AUCUN repli navigateur : le projet n'a plus de moteur pour le web. On
        // échoue FORT et clairement, plutôt que de laisser croire qu'un modèle
        // tourne dans la page.
        throw new Error(
          "le modèle ne tourne QUE dans l'application Android (llama.cpp natif). " +
            "Cette page web n'exécute aucun modèle : installe et ouvre l'appli sur le téléphone.",
        );
      }
      // Import dynamique : le plugin Capacitor/llama.cpp n'existe pas dans un
      // navigateur. On ne le résout que lorsqu'on tourne VRAIMENT en natif,
      // donc le build web reste intact.
      const { moteurNatifParDefaut } = await import("@/ai/moteurNatif");
      const { chargerPuisTelecharger, cheminModele, chercherModele, telechargerModeleAutomatique } =
        await import("@/ai/modeleLocal");
      // ORDRE : on CHARGE D'ABORD, on ne télécharge qu'en secours. Le plugin
      // natif cherche le GGUF par son nom de fichier dans huit emplacements —
      // dont /sdcard/Download/ (LlamaCpp.java:1095, `getModelSearchPaths`) — donc
      // un fichier déposé à la main par l'utilisateur est trouvé et chargé sans
      // qu'une requête réseau soit émise. Télécharger d'abord faisait d'un
      // `downloadFile` cassé (c'est le cas sur l'appareil visé) un blocage
      // TOTAL : plus rien ne marchait, même avec le fichier disponible.
      // Le téléchargement reste un confort, jamais un prérequis.
      // `moteurNatifParDefaut` attend une fonction `ModeleGguf → chemin` ;
      // `cheminModele` prend un identifiant. On les relie par le `.id`.
      //
      // PAS DE CACHE D'ÉTAT DU PROMPT, et c'est volontaire : dans
      // llama-cpp-capacitor 0.1.5, `LlamaCpp.java:801-823` implémente
      // `saveSession`/`loadSession` en ne faisant RIEN (aucune E/S, aucun appel
      // JNI) tout en répondant un succès. Les câbler donnait un cache
      // mensonger — un « sauvé » puis un rechargement à chaque pas, pour rien.
      // La réutilisation du préfixe de prompt, elle, existe déjà et
      // automatiquement, côté natif (`cap-completion.cpp:178`), à condition que
      // le texte réinjecté soit identique : voir `nettoyerPourAffichage`.
      const natif = await moteurNatifParDefaut(
        (m) => cheminModele(m.id),
        // VÉRIFICATION DU FICHIER, branchée pour la TRACE seulement : elle
        // interroge les huit emplacements où le moteur natif cherchera le GGUF
        // (voir chercherModele) et écrit dans le journal lequel contient le
        // fichier, avec sa taille. Elle ne décide de RIEN : le natif reste seul
        // juge de ce qu'il peut ouvrir, et son échec éventuel ne bloque pas.
        async (m) => chercherModele(m.id),
      );
      return {
        nom: "natif",
        // charger → (si échec) télécharger → recharger. Si le modèle est déjà là
        // — y compris posé à la main dans Download —, on s'arrête au premier pas
        // et AUCUNE requête réseau n'est faite.
        charger: async (id, onProgres) => {
          await chargerPuisTelecharger(
            {
              id,
              charger: (p) => natif.charger(id, p, reglagesLive()),
              telecharger: async (p) => {
                // LIVRAISON AUTOMATIQUE : la WebView télécharge (fetch en flux) et
                // écrit dans la mémoire de l'appli ; le téléchargeur du plugin ne
                // sert plus que de repli quand le fetch échoue. Sans ça, il faut
                // 398 Mo téléchargés à la main puis importés — ce n'est pas
                // automatique, c'est un contournement.
                await telechargerModeleAutomatique(id, p);
              },
            },
            onProgres,
          );
        },
        generer: (options) => natif.generer(options),
        // La libération remonte jusqu'au moteur natif : c'est la WebView qui
        // décide de jeter le moteur, mais c'est le processus qui doit rendre la
        // mémoire.
        liberer: () => natif.liberer(),
        tokPerSec: () => natif.derniereVitesse(),
        device: () => (natif.modeleCharge() ? "llama.cpp (natif)" : "moteur natif"),
      };
    })()
      .then((m) => {
        moteur = m;
        return m;
      })
      .catch((e) => {
        moteurEnCours = null; // on autorise une nouvelle tentative
        throw e;
      });
  }
  return moteurEnCours;
}

/**
 * Le harnais d'agent, chargé lui aussi à la demande et par import dynamique :
 * la logique de boucle/outils ne pèse rien sur le premier rendu, et il n'existe
 * aucun chemin serveur pour ce code.
 */
type Harnais = typeof import("@/ai/agent");
let harnais: Harnais | null = null;
let harnaisEnCours: Promise<Harnais> | null = null;

function chargerHarnais(): Promise<Harnais> {
  if (harnais) return Promise.resolve(harnais);
  if (!harnaisEnCours) {
    harnaisEnCours = import("@/ai/agent")
      .then((m) => {
        harnais = m;
        return m;
      })
      .catch((e) => {
        harnaisEnCours = null;
        throw e;
      });
  }
  return harnaisEnCours;
}

export type StudioTab = "preview" | "code" | "console" | "historique";

/** Une version de l'app produite pendant un tour (une par `write_app`). */
export type VersionStudio = {
  pas: number;
  html: string;
  /** Vrai si la production a été coupée par le budget : affichée telle quelle, marquée. */
  tronque: boolean;
  jetons: number | null;
  date: number;
};

export type StudioState = {
  title: string;
  /** L'HTML BRUT du modèle : c'est lui qu'on lit dans l'onglet Code, qu'on compare, qu'on exporte. */
  html: string;
  /** L'HTML rendu dans l'iframe : enveloppé (fond, police) et muni du pont d'écoute. */
  htmlApercu: string;
  /** Numéro de version de l'aperçu : la clé des messages du pont (voir pontApercu.ts). */
  version: number;
  versions: VersionStudio[];
  /** Production en cours (HTML en flux) : l'onglet Code la montre arriver ; `null` hors production. */
  enCours: string | null;
  tronque: boolean;
  /** Question qui a produit cette app, et modèle : pour l'historique. */
  question: string;
  modele: ModelId;
};

/** Compteur GLOBAL de versions d'aperçu : deux versions ne partagent jamais un numéro dans la session. */
let versionApercu = 0;

type SessionState = {
  model: ModelId;
  /**
   * Réglages du moteur (contexte, lot, threads). Le contexte est le levier qui
   * décide si un gros modèle TIENT en mémoire : 96 Mo de cache KV par millier de
   * jetons sur le 30B-A3B.
   */
  reglages: ReglagesMoteur;
  /** Le panneau de réglages est-il ouvert ? */
  reglagesOuverts: boolean;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  /**
   * Poids du modèle chargé, en Go. C'est la taille RÉELLE du fichier GGUF
   * (relevée sur le Hub, voir `MODELS`), pas une lecture de RAM en direct : on
   * n'a pas de mesure de la mémoire vive de l'appareil, donc on n'en invente
   * aucune. L'interface l'étiquette « poids » pour ne pas la faire passer pour
   * une mesure de la RAM occupée.
   */
  memoryGb: number;
  /** Tokens/s MESURÉS sur cet appareil ; 0 tant qu'aucune génération n'a eu lieu. */
  tokPerSec: number;
  /** État du moteur local, pour l'afficher honnêtement dans l'interface. */
  engine: "repos" | "chargement" | "pret" | "erreur";
  engineNote: string;
  /**
   * Chemin MANUEL à afficher quand le modèle est introuvable : nom EXACT du
   * fichier attendu, URL directe à ouvrir dans Chrome, dossier où le poser.
   * `null` quand il n'y a rien à signaler. Aucune dépendance native : c'est ce
   * qui débloque l'utilisateur même quand le téléchargement de l'appli ne
   * démarre pas du tout sur son appareil.
   */
  modeleManuel: CheminManuel | null;
  studio: StudioState | null;
  studioTab: StudioTab;
  studioOpen: boolean;
  /**
   * La console RÉELLE de l'aperçu : erreurs, avertissements et logs émis par
   * l'app dans son iframe, remontés par le pont, avec ligne et colonne quand le
   * moteur JS les donne. Toutes versions confondues ; l'onglet filtre.
   */
  console: EntreeConsole[];
  /** Apps conservées sur l'appareil (IndexedDB), les plus récentes d'abord. */
  historique: AppEnregistree[];
  setModel: (id: ModelId) => void;
  /** Enregistre les réglages et JETTE le moteur en mémoire (reconstruit au message suivant). */
  setReglages: (r: ReglagesMoteur) => void;
  /** Ouvre ou ferme le panneau de réglages. */
  basculerReglages: (ouvert?: boolean) => void;
  send: (text: string) => Promise<void>;
  clear: () => void;
  openStudio: (tab?: StudioTab) => void;
  closeStudio: () => void;
  setStudioTab: (tab: StudioTab) => void;
  /** Recharge l'aperçu (nouvelle version du même HTML) : réessai après une erreur. */
  rechargerApercu: () => void;
  /** Relit la galerie depuis le stockage. */
  rafraichirHistorique: () => Promise<void>;
  /** Rouvre une app de l'historique dans le studio, sans modèle chargé. */
  ouvrirAppHistorique: (app: AppEnregistree) => void;
  supprimerAppHistorique: (id: string) => Promise<void>;
};

// seedMessages SUPPRIMÉ : voir la note sur SEED_PROMPT/SEED_REPLY dans edge0.ts.
// La conversation démarre VIDE — plus aucune réponse écrite en dur à l'écran.

// restingMemory() SUPPRIMÉE : elle interpolait entre `idleGb` et `peakGb` avec
// des coefficients inventés (0,42). La mémoire affichée est maintenant
// directement le poids réel du modèle (`MODELS[…].idleGb`).

export const useSession = create<SessionState>((set, get) => {
  // Le pont de l'aperçu remonte la console RÉELLE de l'app : chaque entrée est
  // gardée dans le store (l'onglet Console l'affiche, le verdict de write_app
  // la lit). Branché à la création du store — un seul écouteur, borné à 500
  // lignes ; sans fenêtre (rendu serveur), c'est un non-événement.
  installerEcouteApercu((entree) => set((s) => ({ console: [...s.console.slice(-499), entree] })));

  return {
  // MODÈLE PAR DÉFAUT : le 0,5B (398 Mo), PAS le 1,5B (986 Mo).
  // Le premier lancement impose un téléchargement : 986 Mo pour le 1,5B contre
  // 398 Mo pour le 0,5B, et rien d'autre ne peut avancer tant qu'il dure. Le
  // 0,5B est ~2,5 fois plus léger, ce qui permet de tester la
  // MÉCANIQUE (téléchargement → chargement natif → premier jeton) rapidement.
  // Les deux autres modèles restent dans le sélecteur (`MODELS`, edge0.ts) :
  // l'utilisateur monte en qualité quand la chaîne est prouvée. C'est un défaut,
  // pas une rétrogradation : rien n'est retiré.
  model: "coder05",
  // Réglages lus du stockage (défauts : 4096 jetons, lot 512, threads auto).
  reglages: lireReglages("coder05"),
  reglagesOuverts: false,
  // Conversation VIDE au démarrage : aucune fausse conversation pré-affichée.
  messages: [],
  streaming: false,
  error: null,
  // Poids réel du 0,5B (398 Mo) : pas une valeur de pointe inventée.
  memoryGb: MODELS.coder05.idleGb,
  tokPerSec: 0,
  engine: "repos",
  engineNote: "",
  modeleManuel: null,
  studio: null,
  studioTab: "preview",
  studioOpen: false,
  console: [],
  historique: [],

  setModel: (id) => {
    if (get().streaming) return;
    // Changer de modèle recharge le moteur : le débit mesuré ne vaut plus rien,
    // et l'indication manuelle de l'ancien fichier ne vaut plus rien non plus.
    set({
      model: id,
      // Le contexte maximal et le cache KV dépendent du modèle : les réglages
      // sont relus POUR LUI — un 32768 resté d'un petit modèle ferait exploser
      // la mémoire avec le 30B.
      reglages: lireReglages(id),
      memoryGb: MODELS[id].idleGb,
      tokPerSec: 0,
      engine: "repos",
      engineNote: "",
      modeleManuel: null,
    });
  },

  setReglages: (r) => {
    if (get().streaming) return;
    ecrireReglages(r);
    // Le moteur en mémoire a été construit avec les ANCIENS réglages : on le jette
    // ET on libère sa mémoire native — sinon deux contextes cohabitent, et sur le
    // 30B c'est 8 Go + 8 Go, donc l'appli tuée par le système.
    const ancien = moteur;
    moteur = null;
    moteurEnCours = null;
    if (ancien) {
      void ancien.liberer().catch(() => {
        /* libération impossible : le prochain chargement remplacera le contexte */
      });
    }
    set({
      reglages: r,
      engine: "repos",
      engineNote:
        "réglages enregistrés : le moteur se rechargera au prochain message " +
        `(contexte ${r.nCtx} jetons, lot ${r.nBatch}, threads ${r.nThreads === 0 ? "auto" : r.nThreads})`,
      tokPerSec: 0,
    });
    void import("@/ai/journal")
      .then(({ noter }) =>
        noter(
          `réglages moteur changés : n_ctx=${r.nCtx}, n_batch=${r.nBatch}, ` +
            `n_threads=${r.nThreads === 0 ? "auto" : r.nThreads}`,
        ),
      )
      .catch(() => {
        /* le journal n'est pas indispensable ici */
      });
  },

  basculerReglages: (ouvert) => set({ reglagesOuverts: ouvert ?? !get().reglagesOuverts }),

  clear: () => {
    if (get().streaming) return;
    set({
      messages: [],
      error: null,
      studio: null,
      studioOpen: false,
      console: [],
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

  rechargerApercu: () => {
    const studio = get().studio;
    if (!studio) return;
    // Nouvelle version du MÊME HTML : l'iframe se recharge, le pont repart avec
    // un numéro neuf, et la console de cette version repart de zéro — les
    // anciennes lignes restent, datées, sous leur version.
    const version = ++versionApercu;
    preparerVersion(version);
    set({ studio: { ...studio, version, htmlApercu: injecterPont(wrapHtml(studio.html), version) } });
  },

  rafraichirHistorique: async () => {
    set({ historique: await listerApps() });
  },

  ouvrirAppHistorique: (app) => {
    if (get().streaming) return;
    const version = ++versionApercu;
    preparerVersion(version);
    set({
      studio: {
        title: app.titre,
        html: app.html,
        htmlApercu: injecterPont(wrapHtml(app.html), version),
        version,
        versions: app.versions.map((v) => ({ ...v })),
        enCours: null,
        tronque: app.metriques.tronque,
        question: app.question,
        modele: (["coder3b", "coder15", "coder05"] as const).includes(app.modele as ModelId)
          ? (app.modele as ModelId)
          : get().model,
      },
      studioTab: "preview",
      studioOpen: true,
    });
  },

  supprimerAppHistorique: async (id) => {
    const { supprimerApp } = await import("@/ai/historique");
    await supprimerApp(id);
    set({ historique: await listerApps() });
  },

  // tickIdle() SUPPRIMÉE.
  // Elle faisait « respirer » la mémoire affichée avec deux sinusoïdes
  // (Math.sin(t / 1400) * 0.02 + Math.sin(t / 410) * 0.01) : un chiffre animé,
  // joli, mais entièrement fabriqué au-dessus d'une valeur déjà approximative.
  // La mémoire n'est pas un indicateur d'activité ; elle est affichée telle
  // qu'on la connaît (le poids du fichier), sans oscillation inventée.

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
      // Poids réel du modèle, pas une « valeur de pointe » inventée.
      memoryGb: profile.idleGb,
    });

    let content = "";
    let thinking = "";
    const tools: ToolEvent[] = [];
    /** Sortie BRUTE du pas en cours (contrat, décision), en flux — jamais mise dans `content`. */
    let brouillon = "";
    /** Les appels au moteur de ce tour, dans l'ordre (`id`), tels que la boucle les clôt. */
    let pasDuTour: PasAgent[] = [];
    let achevement: EtatAchevement | undefined;
    const debutTour = Date.now();

    const patchAssistant = (extra?: Partial<SessionState>) => {
      set((s) => ({
        ...extra,
        messages: s.messages.map((m) =>
          m.id === assistant.id
            ? { ...m, content, thinking, tools: [...tools], brouillon, pas: pasDuTour, achevement }
            : m,
        ),
      }));
    };


    /**
     * Débit et poids RÉELS pendant la génération.
     *
     * Le débit vient UNIQUEMENT du moteur (`moteur.tokPerSec()`) : une mesure
     * réelle de llama.cpp. Il n'est PLUS estimé à partir des caractères reçus —
     * l'ancien `tokens / elapsed`, avec `pending.length / 4`, comptait des
     * caractères et les faisait passer pour des jetons ; le chiffre affiché
     * dépendait donc du texte et était faux. Sans mesure, on laisse 0, et
     * l'interface écrit « — » au lieu d'un « 0,0 tok/s » qui se lirait comme
     * une mesure. La mémoire, elle, reste le poids réel du fichier.
     */
    const pulse = (_busy?: boolean) => ({
      tokPerSec: moteur ? (moteur.tokPerSec() ?? 0) : 0,
      memoryGb: profile.idleGb,
    });

    try {
      // PLUS AUCUNE RÉPONSE ÉCRITE EN DUR, ET PLUS AUCUN ROUTAGE PAR MOTS-CLÉS.
      //
      // Il y avait ici un premier étage « mini-apps locales » : un routeur à
      // mots-clés (`resolveLocalTurn`) qui, dès qu'une demande contenait
      // « html », « jeu », « canvas », « widget »… renvoyait une application
      // ping-pong PRÉ-ÉCRITE dans le code et l'ouvrait dans le studio. Le
      // résultat constaté sur téléphone : demander du CODE ouvrait un ping-pong,
      // et la question posée n'atteignait jamais le modèle.
      //
      // Ce qui a été supprimé (fichier `src/lib/local-apps.ts`, en entier) :
      //   - les trois applications écrites à la main (ping-pong, snake,
      //     particules) et leur HTML complet ;
      //   - le routeur à mots-clés qui les déclenchait ;
      //   - le calcul local « calcule X » (le calcul était RÉEL, mais le routage
      //     restait un mot-clé écrit en dur qui court-circuitait le modèle).
      //
      // DÉSORMAIS : toute demande va au modèle local, qui répond ou appelle un
      // outil (`write_app`, `run_js`) ; rien n'est servi depuis le code.
      // Le harnais D'AGENT, en local. Aucune requête sortante.
      //    Le moteur natif n'est résolu qu'ici, au premier message ;
      //    `chargerMoteur` choisit une fois pour toute la session.
      const moteurActif = await chargerMoteur(() => get().reglages);
      const harnais = await chargerHarnais();
      let pending = "";
      let raf = 0;
      const flushTokens = () => {
        raf = 0;
        if (!pending) return;
        // Dans le BROUILLON, pas dans `content` : la sortie brute d'un pas
        // (contrat, décision) n'est pas la réponse. C'était le défaut C4.
        brouillon += pending;
        // Plus de `tokens += pending.length / 4` : on ne déduit plus un nombre de
        // jetons de la longueur du texte (voir `pulse`). Le débit affiché est
        // celui, mesuré, que rend le moteur natif.
        pending = "";
        patchAssistant(pulse(true));
      };

      // Le premier appel charge le modèle : on le dit à l'écran. Le modèle est
      // TÉLÉCHARGÉ au premier lancement (le GGUF n'est pas embarqué dans l'APK),
      // puis chargé en mémoire. On ne présume donc pas de la phase : la
      // progression qui suit (« telechargement » → « initialisation » → « pret »)
      // la nomme.
      //
      // `chargementReel` distingue « il y a quelque chose à charger » de « le
      // moteur est déjà prêt ». C'est ce drapeau qui empêche d'ouvrir un libellé
      // de phase — et donc de démarrer une horloge — sur un message suivant.
      const chargementReel = get().engine !== "pret";
      if (chargementReel) {
        thinking = `Chargement de ${profile.name}…`;
        set({ engine: "chargement", engineNote: "préparation du modèle local" });
        patchAssistant({ memoryGb: profile.idleGb });
      }

      // Progression RÉELLE, en deux phases, avec les OCTETS et pas seulement un
      // pourcentage : l'utilisateur doit pouvoir lire « téléchargement du modèle
      // 42 % (430 Mo / 986 Mo) », pas un écran figé. Les tailles sont mises en
      // forme par `tailleLisible`, la MÊME fonction que les messages d'erreur.
      // `tailleLisible` est importé ici (et non en tête de fichier) pour la même
      // raison que le reste des modules natifs : ne pas les faire résoudre par le
      // build web au chargement.
      const { tailleLisible } = await import("@/ai/modeleLocal");
      // LA TRACE (voir journal.ts) : les mêmes étapes que celles affichées, mais
      // dans un fichier — l'utilisateur n'a que son téléphone, pas de `adb`.
      const { etatJournal, journaliser: tracer } = await import("@/ai/journal");
      let phase: PhaseChargement = "telechargement";
      // DERNIÈRE ÉTAPE RÉELLE annoncée par le moteur. C'est elle qu'on affiche
      // pendant le chargement : « recherche du modèle… », « lecture du modèle et
      // initialisation du moteur… ». Un nom d'étape ne peut être affiché que si
      // l'étape tourne vraiment — donc l'écran ne peut pas mentir sur l'avancement.
      let derniereEtape: EtapeChargement | null = null;
      await tracer(
        `demande traitée : modèle « ${get().model} » (${profile.name}), ` +
          `état du moteur avant chargement : ${get().engine}`,
      );
      // Dernier état de téléchargement SANS les secondes : l'horloge ci-dessous
      // le réaffiche en rafraîchissant le temps, pour que l'écran bouge même si
      // le plugin cesse d'émettre des octets.
      let etatTelechargement = "";
      // FERMETURE DU LIBELLÉ. `phaseClose` est la garde qui empêche l'horloge de
      // réécrire quoi que ce soit après une réussite ; `arretHorloge` la
      // supprime pour de bon. Sans cette fermeture, le libellé restait ouvert :
      // une horloge d'une seconde continuait d'écrire « lecture du modèle… N s »
      // alors que le moteur était chargé et que le modèle avait déjà répondu —
      // jusqu'à afficher des centaines de secondes.
      let phaseClose = false;
      let horloge: ReturnType<typeof setInterval> | null = null;
      const arretHorloge = () => {
        if (horloge !== null) {
          clearInterval(horloge);
          horloge = null;
        }
      };
      const debutChargement = Date.now();

      /** Ferme le libellé de phase sur la durée RÉELLE, une fois pour toutes. */
      const clorePhase = (ms: number) => {
        if (phaseClose) return;
        phaseClose = true;
        arretHorloge();
        etatTelechargement = "";
        // Durée FIGÉE, mesurée : plus d'horloge, plus de secondes qui courent.
        const label = `moteur prêt en ${dureeLisible(ms)}`;
        thinking = label;
        set({ engineNote: `${label} · ${moteurActif.device()}` });
        patchAssistant({ memoryGb: profile.idleGb });
      };

      // L'horloge n'est créée QUE s'il y a réellement un chargement à suivre :
      // sur un message suivant, il n'y a rien à minuter, et une horloge oubliée
      // est exactement ce qui produisait le compteur infini.
      if (chargementReel) {
        horloge = setInterval(() => {
          if (phaseClose) {
            arretHorloge();
            return;
          }
          const sec = Math.round((Date.now() - debutChargement) / 1000);
          if (phase === "initialisation") {
            // CE QUI SE PASSE VRAIMENT ICI, et rien d'autre : l'appel `initLlama`
            // — lecture du GGUF PAR PROJECTION MÉMOIRE (`use_mmap: true`, le
            // défaut de llama.cpp), puis création du contexte et du cache KV.
            // C'EST UN SEUL APPEL NATIF : on ne le découpe donc pas en deux
            // étapes à l'écran, ce serait inventer une frontière que le code ne
            // franchit pas. AUCUNE compilation n'a lieu sur l'appareil : les
            // noyaux ARM sont compilés au BUILD (CI) et livrés dans
            // `libllama-cpp-arm64.so`. Le nom de l'étape dit ce qui tourne ; le
            // nombre de secondes est MESURÉ, jamais estimé.
            thinking = `${libelleEtape(derniereEtape ?? "initialisation_moteur")} ${sec} s`;
          } else if (phase === "telechargement" && etatTelechargement) {
            // On rappelle le dernier état connu et on remet les SECONDES à jour :
            // un silence du plugin se voit tout de suite, et le délai de garde de
            // `telechargerModele` (60 s sans octet nouveau) tranche ensuite.
            thinking = `${etatTelechargement} — ${sec} s`;
          } else {
            return;
          }
          patchAssistant(pulse(true));
        }, 1000);
      }

      try {
        await moteurActif.charger(get().model, (p) => {
          phase = p.phase;
          if (p.etape) derniereEtape = p.etape;
          const sec = Math.round(p.ecouleMs / 1000);
          if (p.phase === "telechargement") {
            // Octets réels quand le plugin les donne, repli sur la taille connue
            // du GGUF sinon — jamais un « / 0 Mo » ni un pourcentage inventé.
            const recus = typeof p.octetsRecus === "number" ? p.octetsRecus : 0;
            const total =
              typeof p.octetsTotal === "number" && p.octetsTotal > 0
                ? p.octetsTotal
                : profile.diskGb * 1e9;
            etatTelechargement = `téléchargement du modèle ${p.pct} % (${tailleLisible(recus)} / ${tailleLisible(total)})`;
            thinking = `${etatTelechargement} — ${sec} s`;
            set({ engineNote: `${etatTelechargement} — ${sec} s` });
          } else if (p.phase === "initialisation") {
            // LE NOM DE L'ÉTAPE RÉELLE, et seulement lui : « recherche du modèle
            // sur le téléphone… » ou « lecture du modèle et initialisation du
            // moteur… ». C'est ce qui distingue « occupé » de « bloqué » sans
            // inventer de durée : le libellé ne peut apparaître que si l'étape
            // tourne, et les secondes affichées sont mesurées.
            const libelle = libelleEtape(p.etape ?? "initialisation_moteur");
            thinking = `${libelle} ${sec} s`;
            set({ engineNote: `${libelle} — ${sec} s` });
          } else {
            // « pret » : le chargement est RÉELLEMENT terminé. On ferme ICI, sur
            // `p.ecouleMs` — le temps que le moteur lui-même a mesuré —, au lieu
            // d'attendre la fin de la boucle d'agent et de laisser le libellé
            // ouvert entre-temps.
            clorePhase(p.ecouleMs);
            // OÙ EST LA TRACE, écrit dans la trace elle-même : si l'emplacement
            // n'est PAS ouvrable par l'utilisateur (repli), c'est dit ici — sans
            // quoi il chercherait un fichier que son gestionnaire ne montre pas.
            const journal = etatJournal();
            if (journal.chemin) {
              void tracer(
                `trace de cette session : ${journal.chemin}` +
                  (journal.visible ? "" : " — emplacement NON ouvrable depuis le téléphone"),
              );
            }
          }
          patchAssistant({ memoryGb: profile.idleGb });
        });
        // Réussite SILENCIEUSE : certains chemins n'émettent pas de phase
        // « pret ». On ferme quand même, avec NOTRE mesure, plutôt que de
        // laisser un libellé ouvert. Un moteur déjà chargé n'arrive pas ici : le
        // libellé n'a jamais été ouvert pour lui.
        if (chargementReel) clorePhase(Date.now() - debutChargement);
      } finally {
        arretHorloge();
      }

      // Boucle d'agent : le modèle énonce un CONTRAT, décide d'appeler des
      // outils (décision minuscule sous grammaire), produit le contenu long en
      // texte libre, et ne conclut que sur un `done` RECOUPÉ par l'exécution.
      // Chaque appel au moteur remonte ici avec son bilan réel (`onPas`), et
      // l'état d'achèvement à chaque changement (`onAchevement`).
      let rafProduction = 0;
      let productionEnCours = "";
      const flushProduction = () => {
        rafProduction = 0;
        const studio = get().studio;
        // L'HTML arrive EN FLUX dans l'onglet Code, sans toucher à l'iframe
        // (qui ne se recharge qu'une fois, à la fin, sur le document complet).
        set({
          studio: studio
            ? { ...studio, enCours: productionEnCours }
            : {
                title: "App en cours d'écriture",
                html: "",
                htmlApercu: "",
                version: 0,
                versions: [],
                enCours: productionEnCours,
                tronque: false,
                question: text,
                modele: get().model,
              },
          studioOpen: true,
          studioTab: get().studio ? get().studioTab : "code",
        });
      };
      const libellePhase = (phase: string, outil: string | undefined) => {
        if (phase === "contrat") return "contrat : le modèle énonce les critères…";
        if (phase === "decision") return "décision : choix de l'outil…";
        if (outil === "write_app") return "production : le modèle écrit l'app…";
        if (outil === "run_js") return "production : le modèle écrit le code à exécuter…";
        return "production : rédaction de la réponse…";
      };

      const resultat = await harnais.boucleAgent({
        question: text,
        system: systemPrompt(get().model),
        generate: async (demande) => {
          // Un nouvel appel : le brouillon repart de zéro, la phase est nommée.
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
          pending = "";
          brouillon = "";
          if (demande.phase === "production" && demande.outil === "write_app") productionEnCours = "";
          thinking = libellePhase(demande.phase, demande.outil);
          patchAssistant(pulse(true));
          let premier = true;
          let bilan: BilanGeneration | null = null;
          const texte = await moteurActif.generer({
            system: demande.system,
            history: demande.history,
            // BUDGET PAR PHASE ET PAR OUTIL (agent.ts, `BUDGETS`) : plus un
            // chiffre unique. La décision tient en 48 jetons ; l'HTML d'une
            // app en a 1500, et s'arrête sur </html>.
            maxNewTokens: demande.budget,
            stop: demande.stop,
            // Contrainte de sortie structurée : la grammaire GBNF du contrat ou
            // de la décision. La production n'en a jamais.
            grammar: demande.contraintes?.grammar,
            jsonSchema: demande.contraintes?.jsonSchema,
            onToken: (t) => {
              if (premier) {
                premier = false;
                thinking = libellePhase(demande.phase, demande.outil).replace("…", " (en cours)");
              }
              // ROUTAGE DU FLUX : l'HTML d'une app arrive dans l'onglet Code ;
              // tout le reste (contrat, décision, code, réponse) dans le
              // brouillon du bloc de travail — jamais dans `content`.
              if (demande.phase === "production" && demande.outil === "write_app") {
                productionEnCours += t;
                if (!rafProduction) rafProduction = requestAnimationFrame(flushProduction);
                return;
              }
              pending += t;
              if (!raf) raf = requestAnimationFrame(flushTokens);
            },
            onBilan: (b) => {
              bilan = b;
            },
            onEtape: (etape) => {
              // L'ÉTAPE RÉELLE DU MOTEUR, telle quelle : « premier calcul… »
              // pendant le pré-remplissage. « terminé » est ignoré ici : c'est la
              // mesure de débit ci-dessous qui prend la suite, avec des chiffres.
              if (etape === "termine") return;
              if (etape === "premier_calcul") {
                thinking = `${libellePhase(demande.phase, demande.outil)} ${libelleEtape(etape)}`;
                patchAssistant(pulse(true));
              }
            },
            onVitesse: (tokParSeconde, jetons, ms) => {
              // Chiffres rendus par le moteur, écrits tels quels dans le fil.
              const morceaux = [
                jetons > 0 ? `${jetons} jetons` : null,
                `${tokParSeconde.toFixed(1)} tok/s`,
                ms > 0 ? `${dureeLisible(ms)} de décodage` : null,
              ].filter((m): m is string => m !== null);
              thinking = morceaux.join(" · ");
              patchAssistant(pulse(true));
              set({
                tokPerSec: arrondiVitesse(tokParSeconde),
                engineNote: `${moteurActif.device()} · ${tokParSeconde.toFixed(1)} tok/s`,
              });
            },
          });
          return { texte, bilan };
        },
        onPas: (p) => {
          // La frise : une ligne par appel au moteur, la même donnée que la
          // ligne de trace écrite par la boucle (`ligneTracePas`).
          pasDuTour = [...pasDuTour.filter((x) => x.id !== p.id), p].sort((a, b) => a.id - b.id);
          patchAssistant(pulse(true));
        },
        onAchevement: (etat) => {
          achevement = etat;
          patchAssistant(pulse(true));
        },
        onEtape: (etape) => {
          const t: ToolEvent = {
            id: newId(),
            name: etape.outil,
            status: "done",
            args: etape.args,
            result: etape.resultat.slice(0, 200),
          };
          tools.push(t);
          patchAssistant(pulse(true));
        },
        // VÉRIFICATION LÀ OÙ LE CODE TOURNE : Worker pour un calcul pur ; pour
        // une app, exécution DANS l'aperçu et verdict de l'aperçu réel. Sans
        // aperçu monté, le critère est « non vérifié » — jamais une erreur
        // fabriquée par un environnement où le code ne tourne pas.
        verifier: creerVerificateur({
          executerJs: harnais.executerJsStructure,
          // Un critère « le script affiche 4 » est vérifié en LANÇANT le script :
          // la preuve est sa sortie réelle, jamais la déclaration du modèle.
          executerPython: async (code) => {
            const r = await (await chargerExecuteurPython())(code);
            return r.ok ? { ok: true, valeur: r.sortie } : { ok: false, erreur: r.erreur ?? "erreur python" };
          },
          executerDansApercu: (code) => (apercuDisponible() ? evaluerDansApercu(code) : Promise.resolve(null)),
          verdictApercu: () => {
            const version = get().studio?.version ?? 0;
            return version > 0 ? verdictApercu(version, () => get().console) : Promise.resolve(null);
          },
        }),
        executer: async (outil) => {
          if (outil.nom === "run_js") {
            return harnais.executerJs(String(outil.args.code ?? ""));
          }
          if (outil.nom === "run_python") {
            const code = String(outil.args.code ?? "");
            if (!code.trim()) return "erreur : script python vide, rien n'a été exécuté";
            const executerPy = await chargerExecuteurPython();
            const r = await executerPy(code);
            // MONTRER LE FONCTIONNEMENT : ce que le script a réellement affiché
            // (et son erreur exacte) va dans la CONSOLE du studio, à côté des
            // erreurs de l'app — la version courante de l'aperçu lui est donnée
            // pour qu'elle s'affiche au bon endroit.
            const version = get().studio?.version ?? 0;
            const ts = Date.now();
            const lignes: EntreeConsole[] = [
              ...(r.sortie.trim() ? r.sortie.split("\n") : []).map((message) => ({
                niveau: "log" as const,
                message,
                ligne: null,
                colonne: null,
                ts,
                version,
              })),
              ...(!r.ok && r.erreur ? r.erreur.split("\n") : []).map((message) => ({
                niveau: "error" as const,
                message,
                ligne: null,
                colonne: null,
                ts,
                version,
              })),
            ];
            if (lignes.length > 0) set((st) => ({ console: [...st.console, ...lignes].slice(-500) }));
            void import("@/ai/journal")
              .then(({ noter }) =>
                noter(
                  `python : ${r.ok ? "sortie" : "ERREUR"} en ${r.ms} ms, ` +
                    `${r.sortie.split("\n").filter(Boolean).length} ligne(s) affichée(s)` +
                    `${r.premierAppel ? " (chargement de Python compris)" : ""}`,
                ),
              )
              .catch(() => {
                /* le journal n'est pas indispensable ici */
              });
            // Ce que le MODÈLE reçoit : la sortie réelle, ou l'erreur exacte avec
            // sa ligne — c'est ce qui lui permet de corriger au pas suivant.
            if (!r.ok) {
              return (
                `erreur python : ${r.erreur}` +
                (r.sortie.trim() ? `\n(sortie avant l'erreur :\n${r.sortie})` : "")
              );
            }
            return r.sortie.trim() ? r.sortie : "(le script s'est exécuté sans rien afficher)";
          }
          if (outil.nom === "write_app") {
            const titre = String(outil.args.title ?? "App");
            const html = String(outil.args.html ?? "");
            const tronque = outil.args.tronque === true;
            const jetons = typeof outil.args.jetons === "number" ? outil.args.jetons : null;
            const pas = typeof outil.args.pas === "number" ? outil.args.pas : 0;
            if (!html.trim()) return "erreur : html vide, rien n'a été écrit";
            if (rafProduction) cancelAnimationFrame(rafProduction);
            rafProduction = 0;
            // NOUVELLE VERSION de l'aperçu : le pont porte son numéro, donc les
            // messages tardifs de la version précédente ne comptent pas.
            const version = ++versionApercu;
            preparerVersion(version);
            const precedent = get().studio;
            const versions: VersionStudio[] = [
              ...(precedent?.question === text ? precedent.versions : []),
              { pas, html, tronque, jetons, date: Date.now() },
            ];
            set({
              studio: {
                title: titre,
                html,
                htmlApercu: injecterPont(wrapHtml(html), version),
                version,
                versions,
                enCours: null,
                tronque,
                question: text,
                modele: get().model,
              },
              studioTab: "preview",
              studioOpen: true,
            });
            // VÉRIFICATION DANS L'IFRAME, plus dans un Worker : on attend le
            // signal de chargement du pont, puis une garde (les erreurs d'une
            // app arrivent souvent au premier requestAnimationFrame), et on
            // renvoie au modèle les erreurs RÉELLES, avec ligne et colonne.
            const entete = `application « ${titre} » écrite dans le studio (version ${versions.length})`;
            const verdict = await verdictApercu(version, () => get().console);
            if (verdict === null) {
              return `${entete}. Aperçu NON monté : le rendu n'a pas pu être vérifié.`;
            }
            const erreurs = verdict.erreurs.length
              ? ` — ${verdict.erreurs.length} erreur(s) console : ${verdict.erreurs.slice(0, 3).join(" | ")}`
              : " — aucune erreur console";
            if (!verdict.charge) {
              return `${entete}. Aperçu réel : la fin du chargement n'a PAS été signalée en 4 s${erreurs}`;
            }
            return `${entete}. Aperçu réel : chargée${erreurs}`;
          }
          if (outil.nom === "remember") {
            const notes = harnais.ajouterMemoire(String(outil.args.note ?? ""));
            return `noté (${notes.length} fait(s) en mémoire)`;
          }
          return `outil inconnu : ${outil.nom}`;
        },
      });

      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (rafProduction) cancelAnimationFrame(rafProduction);
      rafProduction = 0;
      pending = "";
      brouillon = "";
      // C4 CORRIGÉ : la réponse affichée est la réponse ANALYSÉE par le
      // harnais (`resultat.reponse`), plus la concaténation des sorties brutes de
      // chaque pas. Le nettoyage d'affichage ne touche que ce qui part à l'écran.
      const { nettoyerPourAffichage } = await import("@/ai/moteurNatif");
      content = nettoyerPourAffichage(resultat.reponse);
      achevement = resultat.achevement;
      // Le bloc de travail affiche l'état d'achèvement complet (critères, pas,
      // tronqué) : la ligne de résumé y figure déjà, on ne la répète pas ici.
      thinking = "";
      void import("@/ai/journal").then(({ noter }) => noter(`tour terminé · ${resumeAchevement(resultat.achevement)}`));
      const studioFinal = get().studio;
      if (studioFinal && studioFinal.enCours !== null) set({ studio: { ...studioFinal, enCours: null } });

      // HISTORIQUE : l'app produite est conservée sur l'appareil, avec ses
      // versions (dont les tronquées, marquées) et les métriques MESURÉES du
      // tour. `null` là où rien n'a été mesuré.
      const studioProduit = get().studio;
      if (resultat.html && studioProduit && studioProduit.question === text) {
        const bilans = pasDuTour.map((p) => p.bilan).filter((b): b is BilanGeneration => b !== null);
        const jetonsProduits = bilans.reduce<number | null>(
          (acc, b) => (b.jetonsPredits === null ? acc : (acc ?? 0) + b.jetonsPredits),
          null,
        );
        const vitesse = moteurActif.tokPerSec();
        const reglages = get().reglages;
        const app: AppEnregistree = {
          id: newId(),
          date: Date.now(),
          titre: studioProduit.title,
          question: text,
          modele: get().model,
          reglages: { nCtx: reglages.nCtx, nBatch: reglages.nBatch, nThreads: reglages.nThreads },
          html: studioProduit.html,
          versions: studioProduit.versions.map((v) => ({ ...v })),
          metriques: {
            tokParSeconde: vitesse,
            jetonsProduits,
            dureeMs: Date.now() - debutTour,
            pasUtilises: resultat.achevement.pasUtilises,
            criteres: criteresLisibles(resultat.achevement),
            conclu: resultat.achevement.conclu,
            tronque: resultat.achevement.tronque,
          },
        };
        void enregistrerApp(app)
          .then(() => listerApps())
          .then((historique) => set({ historique }))
          .catch((e) => {
            void import("@/ai/journal").then(({ noter }) =>
              noter(`historique : enregistrement impossible — ${e instanceof Error ? e.message : String(e)}`),
            );
          });
      }

      const vitesse = moteurActif.tokPerSec();
      set((s) => ({
        messages: s.messages.map((msg) =>
          msg.id === assistant.id
            ? { ...msg, content, thinking, tools: [...tools], brouillon: "", pas: pasDuTour, achevement }
            : msg,
        ),
        streaming: false,
        memoryGb: MODELS[s.model].idleGb,
        // Le débit du moteur reste affiché. `null` veut dire « rien à montrer » :
        // on laisse 0, et l'interface écrit « — » au lieu de « 0,0 tok/s », qui
        // se lirait comme un chiffre relevé.
        tokPerSec: vitesse === null ? 0 : arrondiVitesse(vitesse),
        engine: "pret",
        engineNote:
          vitesse === null
            ? moteurActif.device()
            : `${moteurActif.device()} · ${vitesse.toFixed(1)} tok/s`,
        // Le modèle est chargé : plus rien à télécharger à la main.
        modeleManuel: null,
      }));
    } catch (e) {
      // Le moteur local a échoué : on le DIT, et on n'invente AUCUNE réponse.
      //
      // C'EST ICI QU'ÉTAIT LE MENSONGE. Ce bloc appelait auparavant
      // `resolveLocalTurn(text, true)`, qui renvoyait une phrase pré-écrite
      // (`localChat`) ou une app de gabarit (`fallbackApp`) et la posait comme
      // réponse de l'assistant — l'utilisateur croyait que le modèle avait
      // répondu alors qu'aucun modèle n'avait tourné. Ce repli est supprimé.
      //
      // Désormais l'erreur RÉELLE est affichée telle quelle, traduite en message
      // ACTIONNABLE (« le modèle ne tourne que dans l'appli Android », « le
      // téléchargement ne progresse plus depuis 60 s »…). La réponse de
      // l'assistant porte l'échec, jamais un faux contenu.
      const { cheminManuel, messageErreurActionnable } = await import("@/ai/modeleLocal");
      const { etatJournal, journaliser: tracerErreur, texteErreurComplete } = await import(
        "@/ai/journal"
      );
      const brut = e instanceof Error ? e.message : "moteur local indisponible";
      const msg = messageErreurActionnable(brut, get().model);
      // L'ÉCHEC PART DANS LA TRACE, TEXTE INTÉGRAL compris : c'est la seule
      // forme sous laquelle on saura plus tard pourquoi ça n'a pas démarré, sans
      // dépendre de ce que l'écran a bien voulu montrer.
      await tracerErreur(`ÉCHEC du chargement/moteur : ${texteErreurComplete(e)}`);
      // OÙ LIRE LA TRACE — nommé DANS le message, parce que c'est exactement ce
      // qu'on demande à l'utilisateur après un échec : aller voir ce fichier.
      // Quand l'emplacement retenu est un repli que son gestionnaire de fichiers
      // ne montre PAS, on le dit aussi : le laisser chercher un fichier
      // invisible serait pire que de ne rien dire.
      const journal = etatJournal();
      let mentionTrace = "";
      if (journal.actif && journal.chemin) {
        mentionTrace = journal.visible
          ? ` Trace détaillée : ${journal.chemin} — ouvre-la avec un gestionnaire de fichiers.`
          : ` Trace détaillée : ${journal.chemin}, emplacement que le gestionnaire de fichiers du téléphone ne montre PAS.`;
      } else if (journal.refus.length > 0) {
        // Le journal a été TENTÉ et aucun emplacement n'a accepté l'écriture :
        // c'est une information à part entière, et il FAUT la donner — sinon
        // l'utilisateur cherche un fichier qui n'existe pas. Les erreurs brutes
        // des emplacements refusés sont citées : ce sont elles qui diront
        // pourquoi (permission, stockage non monté…).
        mentionTrace = ` Trace indisponible, aucun emplacement du téléphone n'a accepté l'écriture : ${journal.refus
          .map((r) => `${r.chemin} → ${r.erreur}`)
          .join(" ; ")}.`;
      }
      const msgAffiche = msg + mentionTrace;
      // Le modèle est introuvable : on affiche le chemin MANUEL (nom exact du
      // fichier + URL + dossier Download), qui ne dépend ni du réseau ni de
      // `downloadFile`. C'est ce qui débloque l'utilisateur quand la livraison
      // par l'appli ne fonctionne pas sur son appareil. On le déduit du message
      // lui-même : s'il NOMME le fichier attendu ou son URL, c'est bien le
      // fichier qui manque — pas une erreur sans rapport (RAM, fichier corrompu).
      const manuel = cheminManuel(get().model);
      const mentionneLeFichier =
        msg.includes(manuel.fichier) || msg.includes(manuel.url) || brut.includes(manuel.fichier);
      const introuvable = get().modeleManuel ?? (mentionneLeFichier ? manuel : null);
      // On l'écrit dans le fil de la conversation, en clair, comme message
      // d'ERREUR : le texte dit explicitement que le modèle n'a pas répondu et
      // pourquoi. Ce n'est pas le modèle qui parle, c'est l'appli qui rapporte
      // l'échec réel.
      thinking = msgAffiche;
      const echec = `Le modèle n'a pas répondu : ${msgAffiche}`;
      set((s) => ({
        streaming: false,
        engine: "erreur",
        engineNote: msgAffiche,
        modeleManuel: introuvable,
        memoryGb: MODELS[s.model].idleGb,
        tokPerSec: 0,
        error: echec,
        messages: s.messages.map((m) =>
          m.id === assistant.id
            ? { ...m, thinking, tools: [...tools], content: echec, brouillon: "", pas: pasDuTour, achevement }
            : m,
        ),
      }));
    }
  },
  };
});

function wrapHtml(html: string) {
  if (/<html/i.test(html)) return html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>html,body{margin:0;background:#09090b;color:#ececef;font:14px system-ui}</style></head><body>${html}</body></html>`;
}

/**
 * Durée LISIBLE et FIGÉE — « 820 ms », « 4,3 s », « 42 s », « 3 min 12 s ».
 *
 * Sert au libellé de fin de chargement : l'écran doit afficher une durée RÉELLE
 * et arrêtée, jamais une horloge qui court. Les décimales ne sont gardées que
 * sous les dix secondes, là où elles apprennent quelque chose ; au-delà, « 42 s »
 * se lit mieux que « 42,3 s ».
 */
export function dureeLisible(ms: number): string {
  const valeur = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  if (valeur < 1000) return `${valeur} ms`;
  if (valeur < 10_000) return `${(valeur / 1000).toFixed(1).replace(".", ",")} s`;
  if (valeur < 60_000) return `${Math.round(valeur / 1000)} s`;
  const minutes = Math.floor(valeur / 60_000);
  return `${minutes} min ${Math.round((valeur % 60_000) / 1000)} s`;
}

/** Un débit affiché au dixième : évite les « 8.433333333333334 tok/s ». */
function arrondiVitesse(tokParSeconde: number): number {
  return Math.round(tokParSeconde * 10) / 10;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function htmlFrom(message: ChatMessage): string | null {
  return extractHtmlBlock(message.content);
}
