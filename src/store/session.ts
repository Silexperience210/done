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
import type { GenerateOptions, LocalModelId, PhaseChargement, ProgresChargement } from "@/ai/types";
import { resolveLocalTurn } from "@/lib/local-apps";

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
};

let moteur: MoteurActif | null = null;
let moteurEnCours: Promise<MoteurActif> | null = null;

function chargerMoteur(): Promise<MoteurActif> {
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
      const { chargerPuisTelecharger, cheminModele, telechargerModele } =
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
      const natif = await moteurNatifParDefaut((m) => cheminModele(m.id));
      return {
        nom: "natif",
        // charger → (si échec) télécharger → recharger. Si le modèle est déjà là
        // — y compris posé à la main dans Download —, on s'arrête au premier pas
        // et AUCUNE requête réseau n'est faite.
        charger: async (id, onProgres) => {
          await chargerPuisTelecharger(
            {
              id,
              charger: (p) => natif.charger(id, p),
              telecharger: async (p) => {
                await telechargerModele(id, p);
              },
            },
            onProgres,
          );
        },
        generer: (options) => natif.generer(options),
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
  setModel: (id: ModelId) => void;
  send: (text: string) => Promise<void>;
  clear: () => void;
  openStudio: (tab?: StudioTab) => void;
  closeStudio: () => void;
  setStudioTab: (tab: StudioTab) => void;
};

// seedMessages SUPPRIMÉ : voir la note sur SEED_PROMPT/SEED_REPLY dans edge0.ts.
// La conversation démarre VIDE — plus aucune réponse écrite en dur à l'écran.

// restingMemory() SUPPRIMÉE : elle interpolait entre `idleGb` et `peakGb` avec
// des coefficients inventés (0,42). La mémoire affichée est maintenant
// directement le poids réel du modèle (`MODELS[…].idleGb`).

export const useSession = create<SessionState>((set, get) => ({
  // MODÈLE PAR DÉFAUT : le 0,5B (398 Mo), PAS le 1,5B (986 Mo).
  // Le premier lancement impose un téléchargement ; sur le 1,5B il dure
  // plusieurs minutes sans qu'on puisse vérifier quoi que ce soit d'autre entre
  // temps. Le 0,5B divise ce temps par ~2,5, ce qui permet de tester la
  // MÉCANIQUE (téléchargement → chargement natif → premier jeton) rapidement.
  // Les deux autres modèles restent dans le sélecteur (`MODELS`, edge0.ts) :
  // l'utilisateur monte en qualité quand la chaîne est prouvée. C'est un défaut,
  // pas une rétrogradation : rien n'est retiré.
  model: "coder05",
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

  setModel: (id) => {
    if (get().streaming) return;
    // Changer de modèle recharge le moteur : le débit mesuré ne vaut plus rien,
    // et l'indication manuelle de l'ancien fichier ne vaut plus rien non plus.
    set({
      model: id,
      memoryGb: MODELS[id].idleGb,
      tokPerSec: 0,
      engine: "repos",
      engineNote: "",
      modeleManuel: null,
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

    const patchAssistant = (extra?: Partial<SessionState>) => {
      set((s) => ({
        ...extra,
        messages: s.messages.map((m) =>
          m.id === assistant.id ? { ...m, content, thinking, tools: [...tools] } : m,
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
      // 1) Les mini-apps locales : elles ne dépendent PAS du modèle, elles
      //    répondent instantanément et hors ligne. C'est une fonctionnalité
      //    LOCALE et DÉTERMINISTE (un vrai jeu, un vrai calcul), pas une
      //    imitation du modèle : rien ici ne prétend venir du moteur. Quand
      //    `resolveLocalTurn` renvoie `null`, on passe au modèle local.
      const turn = resolveLocalTurn(text);
      if (turn) {
        await sleep(160);
        thinking = turn.kind === "app" ? "App locale → studio" : "Calcul local → bac à sable";
        patchAssistant(pulse(true));
        await sleep(120);
        const toolName = turn.kind === "app" ? "write_app" : "run_js";
        tools.push({
          id: newId(),
          name: toolName,
          status: "start",
          args: turn.kind === "app" ? { title: turn.app.title } : { code: turn.expression },
        });
        patchAssistant(pulse(true));
        await sleep(110);
        tools[0] = {
          ...tools[0],
          status: "done",
          result: turn.kind === "app" ? turn.app.title : turn.value,
        };
        if (turn.kind === "app") {
          content = turn.app.note;
          set({
            studio: { title: turn.app.title, html: turn.app.html },
            studioTab: "preview",
            studioOpen: true,
            error: null,
          });
        } else {
          content = turn.note;
        }
        patchAssistant({
          ...pulse(false),
          streaming: false,
          memoryGb: MODELS[get().model].idleGb,
          error: null,
          engine: get().engine === "repos" ? "repos" : get().engine,
        });
        return;
      }

      // 2) Le harnais D'AGENT, en local. Aucune requête sortante.
      //    Le moteur natif n'est résolu qu'ici, au premier message ;
      //    `chargerMoteur` choisit une fois pour toute la session.
      const moteurActif = await chargerMoteur();
      const harnais = await chargerHarnais();
      let pending = "";
      let raf = 0;
      const flushTokens = () => {
        raf = 0;
        if (!pending) return;
        content += pending;
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
      let phase: PhaseChargement = "telechargement";
      // Dernier état de téléchargement SANS les secondes : l'horloge ci-dessous
      // le réaffiche en rafraîchissant le temps, pour que l'écran bouge même si
      // le plugin cesse d'émettre des octets.
      let etatTelechargement = "";
      // FERMETURE DU LIBELLÉ. `phaseClose` est la garde qui empêche l'horloge de
      // réécrire quoi que ce soit après une réussite ; `arretHorloge` la
      // supprime pour de bon. Sans cette fermeture, le libellé restait ouvert :
      // une horloge d'une seconde continuait d'écrire « Préparation du moteur…
      // N s » alors que le moteur était chargé et que le modèle avait déjà
      // répondu — jusqu'à afficher des centaines de secondes.
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
            thinking = `Préparation du moteur… ${sec} s. La première fois, la compilation du modèle peut prendre plusieurs minutes sur un téléphone.`;
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
            thinking = `Préparation du moteur… ${sec} s`;
            set({ engineNote: `préparation du moteur — ${sec} s` });
          } else {
            // « pret » : le chargement est RÉELLEMENT terminé. On ferme ICI, sur
            // `p.ecouleMs` — le temps que le moteur lui-même a mesuré —, au lieu
            // d'attendre la fin de la boucle d'agent et de laisser le libellé
            // ouvert entre-temps.
            clorePhase(p.ecouleMs);
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

      // Boucle d'agent : le modèle décide d'appeler des outils, un pas à la
      // fois, et le résultat de chaque outil lui est renvoyé. C'est ce qui fait
      // la différence avec un simple « question → réponse ».
      const resultat = await harnais.boucleAgent({
        question: text,
        system: systemPrompt(get().model),
        maxPas: 4,
        onToken: (t) => {
          pending += t;
          if (!raf) raf = requestAnimationFrame(flushTokens);
        },
        generate: async (prompt, onToken, contraintes) => {
          thinking = "analyse de la demande…";
          patchAssistant(pulse(true));
          let premier = true;
          return moteurActif.generer({
            system: prompt,
            history: [{ role: "user", content: text }],
            // Court volontairement : sur un téléphone, chaque jeton coûte. Les
            // appels d'outils et les réponses utiles tiennent largement là-dedans.
            maxNewTokens: 160,
            // Contrainte de sortie structurée : le schéma JSON (converti en
            // grammaire par llama.cpp) empêche un petit modèle de déverser du
            // texte à la place d'un appel.
            jsonSchema: contraintes?.jsonSchema,
            grammar: contraintes?.grammar,
            onToken: (t) => {
              if (premier) {
                premier = false;
                thinking = "";
              }
              onToken?.(t);
              patchAssistant(pulse(true));
            },
            onVitesse: (tokParSeconde, jetons, ms) => {
              // MESURE RÉELLE, écrite en clair dans le fil : le nombre de jetons
              // vient du moteur, la durée de la fenêtre de décodage. On ne
              // prétend pas que llama.cpp a sorti ce débit — sur Android il ne le
              // calcule pas — on dit qu'il a été MESURÉ sur cet appareil.
              const morceaux = [
                jetons > 0 ? `${jetons} jetons` : null,
                `${tokParSeconde.toFixed(1)} tok/s`,
                ms > 0 ? `${dureeLisible(ms)} de décodage` : null,
              ].filter((m): m is string => m !== null);
              thinking = `${morceaux.join(" · ")} — mesuré sur cet appareil`;
              patchAssistant(pulse(true));
              // APRÈS le rafraîchissement en direct : c'est la mesure qui reste
              // affichée, pas l'estimation intermédiaire.
              set({
                tokPerSec: arrondiVitesse(tokParSeconde),
                engineNote: `${moteurActif.device()} · ${tokParSeconde.toFixed(1)} tok/s mesurés`,
              });
            },
          });
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
        executer: async (outil) => {
          if (outil.nom === "run_js") {
            return harnais.executerJs(String(outil.args.code ?? ""));
          }
          if (outil.nom === "write_app") {
            const titre = String(outil.args.title ?? "App");
            const html = String(outil.args.html ?? "");
            if (!html.trim()) return "erreur : html vide, rien n'a été écrit";
            set({
              studio: { title: titre, html: wrapHtml(html) },
              studioTab: "preview",
              studioOpen: true,
            });
            // VÉRIFICATION : on exécute le JavaScript de l'app écrite et on
            // renvoie l'éventuelle erreur au modèle, qui corrigera au pas suivant.
            const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1];
            if (!script)
              return `application « ${titre} » écrite dans le studio (aucun script à vérifier)`;
            const verdict = await harnais.executerJs(script);
            return `application « ${titre} » écrite dans le studio. Vérification du script : ${verdict}`;
          }
          if (outil.nom === "remember") {
            const notes = harnais.ajouterMemoire(String(outil.args.note ?? ""));
            return `noté (${notes.length} fait(s) en mémoire)`;
          }
          return `outil inconnu : ${outil.nom}`;
        },
      });

      if (raf) cancelAnimationFrame(raf);
      if (pending) flushTokens();
      // Le moteur rend le texte BRUT (c'est ce qui garde le préfixe du cache KV
      // réutilisable, cap-completion.cpp:178). On ne nettoie donc QUE pour
      // l'affichage, et seulement au moment où le texte part à l'écran : les
      // jetons déjà diffusés le sont tels quels.
      const { nettoyerPourAffichage } = await import("@/ai/moteurNatif");
      content = content || nettoyerPourAffichage(resultat.reponse);

      const fence = extractHtmlBlock(content);
      if (fence) {
        // Le modèle a écrit une app : on la pousse dans le studio.
        tools.push({
          id: newId(),
          name: "write_app",
          status: "done",
          result: "bloc HTML du modèle local",
        });
        set({
          studio: { title: "App générée", html: wrapHtml(fence) },
          studioTab: "preview",
          studioOpen: true,
        });
      }

      const vitesse = moteurActif.tokPerSec();
      set((s) => ({
        messages: s.messages.map((msg) =>
          msg.id === assistant.id
            ? { ...msg, content: content || msg.content, thinking, tools: [...tools] }
            : msg,
        ),
        streaming: false,
        memoryGb: MODELS[s.model].idleGb,
        // Le débit MESURÉ pendant la génération reste affiché. `null` veut dire
        // « rien de mesurable » : on laisse 0, et l'interface écrit « — » au lieu
        // de « 0,0 tok/s », qui se lirait comme une mesure.
        tokPerSec: vitesse === null ? 0 : arrondiVitesse(vitesse),
        engine: "pret",
        engineNote:
          vitesse === null
            ? moteurActif.device()
            : `${moteurActif.device()} · ${vitesse.toFixed(1)} tok/s mesurés`,
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
      const brut = e instanceof Error ? e.message : "moteur local indisponible";
      const msg = messageErreurActionnable(brut, get().model);
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
      thinking = msg;
      const echec = `Le modèle n'a pas répondu : ${msg}`;
      set((s) => ({
        streaming: false,
        engine: "erreur",
        engineNote: msg,
        modeleManuel: introuvable,
        memoryGb: MODELS[s.model].idleGb,
        tokPerSec: 0,
        error: echec,
        messages: s.messages.map((m) =>
          m.id === assistant.id ? { ...m, thinking, tools: [...tools], content: echec } : m,
        ),
      }));
    }
  },
}));

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
