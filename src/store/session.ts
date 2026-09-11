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
import { capacitesReelles, choisirMoteur } from "@/ai/moteur";
import type { GenerateOptions, LocalModelId, ProgresChargement } from "@/ai/localModel";
import { resolveLocalTurn } from "@/lib/local-apps";

/**
 * Deux moteurs possibles derrière une SEULE interface.
 *
 * Navigateur : transformers.js (WebGPU/WASM), chargé paresseusement par import
 * dynamique — statiquement, ses 1,14 Mo et les 21,5 Mo de WebAssembly
 * d'onnxruntime partaient dans le bundle de page ET dans celui de la fonction
 * serveur, alors qu'il n'existe aucun chemin serveur pour ce code.
 *
 * Natif : llama.cpp via le plugin Capacitor, uniquement dans l'APK. Le plugin
 * est importé dynamiquement au moment du choix — il ne doit JAMAIS être résolu
 * par le build navigateur, sinon celui-ci casse.
 *
 * Le choix se fait une fois, avec `capacitesReelles()` : natif dans l'appli
 * empaquetée, WebGPU sinon. Tout le reste de `send` ne connaît que `MoteurActif`
 * et ignore lequel des deux tourne.
 */
type ModuleWebgpu = typeof import("@/ai/localModel");
let webgpu: ModuleWebgpu | null = null;
let webgpuEnCours: Promise<ModuleWebgpu> | null = null;

function chargerMoteurWebgpu(): Promise<ModuleWebgpu> {
  if (webgpu) return Promise.resolve(webgpu);
  if (!webgpuEnCours) {
    webgpuEnCours = import("@/ai/localModel")
      .then((m) => {
        webgpu = m;
        return m;
      })
      .catch((e) => {
        webgpuEnCours = null; // on autorise une nouvelle tentative
        throw e;
      });
  }
  return webgpuEnCours;
}

/**
 * Interface COMMUNE aux deux moteurs. Le navigateur expose
 * `loadModel`/`generate`/`metrics` ; le natif expose `charger`/`generer`/
 * `derniereVitesse`. On les ramène ici à la même forme, pour que la boucle
 * d'agent, le streaming jeton par jeton et les pastilles d'outils ne changent
 * pas d'un moteur à l'autre.
 */
type MoteurActif = {
  nom: "webgpu" | "natif";
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
      if (choisirMoteur(capacitesReelles()) === "natif") {
        // Import dynamique : le plugin Capacitor/llama.cpp n'existe pas dans un
        // navigateur. On ne le résout que lorsqu'on tourne VRAIMENT en natif,
        // donc le build web reste intact.
        const { moteurNatifParDefaut } = await import("@/ai/moteurNatif");
        const { cheminModele, telechargerModele } = await import("@/ai/modeleLocal");
        // Le GGUF n'est PLUS embarqué dans l'APK : on le télécharge dans
        // getFilesDir()/Documents/<fichier> (le seul dossier que le plugin natif
        // visite vraiment), puis on passe au moteur le NOM DE FICHIER SEUL.
        // `telechargerModele` est un no-op si le fichier est déjà là et de la
        // bonne taille. On n'envoie plus `is_model_asset` : le natif Android
        // l'ignore.
        // `moteurNatifParDefaut` attend une fonction `ModeleGguf → chemin` ;
        // `cheminModele` prend un identifiant. On les relie par le `.id`.
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
      }
      // Navigateur : EXACTEMENT le moteur d'avant, simplement uniformisé.
      const web = await chargerMoteurWebgpu();
      return {
        nom: "webgpu",
        charger: async (id, onProgres) => {
          await web.loadModel(id, onProgres);
        },
        generer: (options) => web.generate(options),
        tokPerSec: () => web.metrics().tokPerSec,
        device: () => web.metrics().device,
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
  model: "coder15",
  messages: seedMessages,
  streaming: false,
  error: null,
  memoryGb: MODELS.coder15.peakGb,
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
      //    Le moteur (navigateur ou natif) n'est résolu qu'ici, au premier
      //    message ; `chargerMoteur` choisit une fois pour toute la session.
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

      // Le premier appel charge le modèle : on le dit à l'écran. En natif comme
      // dans le navigateur, le modèle est désormais TÉLÉCHARGÉ au premier
      // lancement (le GGUF n'est plus embarqué dans l'APK), puis chargé en
      // mémoire. On ne présume donc pas de la phase : la progression qui suit
      // (« telechargement » → « initialisation » → « pret ») la nomme.
      if (get().engine !== "pret") {
        thinking = `Chargement de ${profile.name}…`;
        set({ engine: "chargement", engineNote: "préparation du modèle local" });
        patchAssistant({ memoryGb: profile.idleGb });
      }

      // Progression RÉELLE en deux phases. La barre atteignait 100 % puis plus
      // rien : c'était la construction de la session ONNX et l'allocation GPU,
      // longues et silencieuses. On les nomme, et on compte les secondes.
      let phase = "telechargement";
      const debutChargement = Date.now();
      const horloge = setInterval(() => {
        if (phase !== "initialisation") return;
        thinking = `Préparation du moteur… ${Math.round((Date.now() - debutChargement) / 1000)} s. La première fois, la compilation du modèle peut prendre plusieurs minutes sur un téléphone.`;
        patchAssistant(pulse(true));
      }, 1000);

      try {
        await moteurActif.charger(get().model, (p) => {
          phase = p.phase;
          const sec = Math.round(p.ecouleMs / 1000);
          if (p.phase === "telechargement") {
            thinking = `Téléchargement de ${profile.name}… ${p.pct} %${p.fichier ? ` (${p.fichier.split("/").pop()})` : ""}`;
            set({ engineNote: `téléchargement ${p.pct} % — ${sec} s` });
          } else if (p.phase === "initialisation") {
            thinking = `Préparation du moteur… ${sec} s`;
            set({ engineNote: `préparation du moteur — ${sec} s` });
          } else {
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
            // texte à la place d'un appel. Le moteur navigateur l'ignore.
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
      content = content || resultat.reponse;

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
