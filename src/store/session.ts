import { create } from "zustand";
import {
  extractHtmlBlock,
  MODELS,
  newId,
  SEED_PROMPT,
  SEED_REPLY,
  systemPrompt,
  type ChatMessage,
  type ModelId,
  type ToolEvent,
} from "@/lib/edge0";
import { estApplicationNative } from "@/ai/moteur";
import type { GenerateOptions, LocalModelId, ProgresChargement } from "@/ai/types";
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
  /** Débit MESURÉ par le moteur, ou null tant qu'il n'a rien mesuré. */
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
      const { cheminModele, telechargerModele } = await import("@/ai/modeleLocal");
      // Le GGUF n'est PAS embarqué dans l'APK : on le télécharge dans
      // getFilesDir()/Documents/<fichier> (le seul dossier que le plugin natif
      // visite vraiment), puis on passe au moteur le NOM DE FICHIER SEUL.
      // `telechargerModele` est un no-op si le fichier est déjà là et de la
      // bonne taille. On n'envoie pas `is_model_asset` : le natif Android
      // l'ignore.
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
        charger: async (id, onProgres) => {
          // 1) livrer le modèle sur le disque, puis 2) initialiser llama.cpp.
          // La progression de téléchargement est remontée telle quelle.
          await telechargerModele(id, onProgres);
          await natif.charger(id, onProgres);
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
  /** Mémoire réellement occupée par les poids du modèle chargé (Go). */
  memoryGb: number;
  /** Tokens/s MESURÉS sur cet appareil ; 0 tant qu'aucune génération n'a eu lieu. */
  tokPerSec: number;
  /** État du moteur local, pour l'afficher honnêtement dans l'interface. */
  engine: "repos" | "chargement" | "pret" | "erreur";
  engineNote: string;
  studio: StudioState | null;
  studioTab: StudioTab;
  studioOpen: boolean;
  setModel: (id: ModelId) => void;
  send: (text: string) => Promise<void>;
  clear: () => void;
  openStudio: (tab?: StudioTab) => void;
  closeStudio: () => void;
  setStudioTab: (tab: StudioTab) => void;
  tickIdle: (t: number) => void;
};

const seedMessages: ChatMessage[] = [
  { id: "seed-u", role: "user", content: SEED_PROMPT },
  { id: "seed-a", role: "assistant", content: SEED_REPLY },
];

/** Mémoire réelle : les poids du modèle, plus le cache KV s'il travaille. */
function restingMemory(model: ModelId, hasReply: boolean) {
  const m = MODELS[model];
  return hasReply ? m.idleGb + (m.peakGb - m.idleGb) * 0.42 : m.idleGb;
}

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
  messages: seedMessages,
  streaming: false,
  error: null,
  memoryGb: MODELS.coder05.peakGb,
  tokPerSec: 0,
  engine: "repos",
  engineNote: "",
  studio: null,
  studioTab: "preview",
  studioOpen: false,

  setModel: (id) => {
    if (get().streaming) return;
    const hasReply = get().messages.some((m) => m.role === "assistant" && m.content);
    // Changer de modèle recharge le moteur : le débit mesuré ne vaut plus rien.
    set({
      model: id,
      memoryGb: restingMemory(id, hasReply),
      tokPerSec: 0,
      engine: "repos",
      engineNote: "",
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

  tickIdle: (t) => {
    if (get().streaming) return;
    const hasReply = get().messages.some((m) => m.role === "assistant" && m.content);
    const base = restingMemory(get().model, hasReply);
    set({
      memoryGb: base + Math.sin(t / 1400) * 0.02 + Math.sin(t / 410) * 0.01,
    });
  },

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
      memoryGb: profile.peakGb,
    });

    const started = performance.now();
    let tokens = 0;
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

    /** Débit et mémoire RÉELS pendant la génération. */
    const pulse = (busy: boolean) => {
      const elapsed = Math.max(0.2, (performance.now() - started) / 1000);
      const measured = moteur ? moteur.tokPerSec() : null;
      if (busy && tokens > 0) {
        const live = tokens / elapsed;
        return {
          tokPerSec: live > 0 ? Math.round(live * 10) / 10 : 0,
          memoryGb: profile.idleGb + (profile.peakGb - profile.idleGb) * 0.6,
        };
      }
      return {
        tokPerSec: measured ?? 0,
        memoryGb: busy ? profile.peakGb : profile.idleGb,
      };
    };

    try {
      // 1) Les mini-apps locales : elles ne dépendent PAS du modèle, elles
      //    répondent instantanément et hors ligne. On les garde telles quelles.
      const turn = resolveLocalTurn(text);
      if (turn.kind !== "chat") {
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
          memoryGb: restingMemory(get().model, true),
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
        tokens += Math.max(1, Math.round(pending.length / 4));
        pending = "";
        patchAssistant(pulse(true));
      };

      // Le premier appel charge le modèle : on le dit à l'écran. Le modèle est
      // TÉLÉCHARGÉ au premier lancement (le GGUF n'est pas embarqué dans l'APK),
      // puis chargé en mémoire. On ne présume donc pas de la phase : la
      // progression qui suit (« telechargement » → « initialisation » → « pret »)
      // la nomme.
      if (get().engine !== "pret") {
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
      let phase = "telechargement";
      // Dernier état de téléchargement SANS les secondes : l'horloge ci-dessous
      // le réaffiche en rafraîchissant le temps, pour que l'écran bouge même si
      // le plugin cesse d'émettre des octets.
      let etatTelechargement = "";
      const debutChargement = Date.now();
      const horloge = setInterval(() => {
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
            etatTelechargement = "";
            set({ engineNote: `prêt en ${sec} s` });
          }
          patchAssistant({ memoryGb: profile.idleGb });
        });
      } finally {
        clearInterval(horloge);
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
              tokens += 1;
              if (premier) {
                premier = false;
                thinking = "";
              }
              onToken?.(t);
              patchAssistant(pulse(true));
            },
            onVitesse: (tokParSeconde, jetons, ms) => {
              thinking = `${jetons} jetons · ${tokParSeconde.toFixed(1)} tok/s · ${Math.round(ms / 1000)} s — mesure réelle, sur ton appareil`;
              patchAssistant(pulse(true));
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
            if (!script) return `application « ${titre} » écrite dans le studio (aucun script à vérifier)`;
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
        memoryGb: restingMemory(s.model, true),
        tokPerSec: vitesse ?? 0,
        engine: "pret",
        engineNote: `${moteurActif.device()}${vitesse ? ` · ${vitesse} tok/s mesurés` : ""}`,
      }));
    } catch (e) {
      // Le moteur local a échoué : on le dit, et on retombe sur les apps locales
      // plutôt que d'inventer une réponse. L'erreur est traduite en message
      // ACTIONNABLE : l'utilisateur doit lire quoi FAIRE, jamais un code brut du
      // moteur natif (« Failed to initialize native context »).
      const { messageErreurActionnable } = await import("@/ai/modeleLocal");
      const brut = e instanceof Error ? e.message : "moteur local indisponible";
      const msg = messageErreurActionnable(brut, get().model);
      // On l'écrit aussi dans le fil de la conversation, en clair : un
      // téléchargement qui ne progresse plus (« le téléchargement ne progresse
      // plus depuis 60 s ») doit être LISIBLE, pas seulement dans un encart.
      // L'utilisateur sait alors qu'il peut relancer — au lieu d'un écran mort.
      thinking = msg;
      const fallback = resolveLocalTurn(text, true);
      const note =
        fallback.kind === "calc"
          ? fallback.note
          : fallback.kind === "chat"
            ? fallback.content
            : "Le moteur local n'a pas pu démarrer.";
      if (fallback.kind === "app") {
        set({
          streaming: false,
          error: null,
          engine: "erreur",
          engineNote: msg,
          studio: { title: fallback.app.title, html: fallback.app.html },
          studioTab: "preview",
          studioOpen: true,
          memoryGb: restingMemory(get().model, true),
          messages: get().messages.map((m) =>
            m.id === assistant.id
              ? { ...m, thinking, tools: [...tools], content: fallback.app.note }
              : m,
          ),
        });
        return;
      }
      set((s) => ({
        streaming: false,
        engine: "erreur",
        engineNote: msg,
        memoryGb: MODELS[s.model].idleGb,
        tokPerSec: 0,
        error: `Moteur local : ${msg}`,
        messages: s.messages.map((m) =>
          m.id === assistant.id ? { ...m, thinking, tools: [...tools], content: note } : m,
        ),
      }));
    }
  },
}));

function wrapHtml(html: string) {
  if (/<html/i.test(html)) return html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>html,body{margin:0;background:#09090b;color:#ececef;font:14px system-ui}</style></head><body>${html}</body></html>`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function htmlFrom(message: ChatMessage): string | null {
  return extractHtmlBlock(message.content);
}
