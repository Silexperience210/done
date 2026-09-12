/**
 * ÉCOUTE DE L'APERÇU — la moitié « fenêtre » du pont (voir `src/ai/pontApercu.ts`
 * pour la moitié pure : script injecté et lecture des messages).
 *
 * Ce module tient l'état d'attente : qui attend la fin de chargement de quelle
 * version, quelle évaluation attend sa réponse. Il ne connaît ni React ni le
 * store : le store lui donne un rappel pour chaque entrée de console, et lui
 * demande des verdicts.
 *
 * TOUT EST BORNÉ PAR UN DÉLAI. Un aperçu qui ne signale jamais son chargement
 * (page vide, script bloquant, iframe fermée par l'utilisateur) rend `false`
 * ou `null` après le délai — jamais une promesse qui pend, jamais un succès
 * supposé. Et `null` veut dire « aucun aperçu n'a répondu » : c'est le cas que
 * le vérificateur classe « non vérifié », pas « échec ».
 */
import type { ResultatExecution } from "@/ai/achevement";
import { lireMessageApercu, type EntreeConsole } from "@/ai/pontApercu";

type Attente<T> = { resoudre: (v: T) => void; minuteur: ReturnType<typeof setTimeout> };

let installe = false;
/** Versions dont le `load` a été reçu : une attente posée après coup est résolue tout de suite. */
const versionsChargees = new Set<number>();
const attentesChargement = new Map<number, Attente<boolean>[]>();
const attentesEval = new Map<string, Attente<ResultatExecution | null>>();
let compteurEval = 0;
/** La fenêtre de l'iframe courante, enregistrée par le composant qui la monte. */
let fenetreApercu: Window | null = null;
let surEntree: ((e: EntreeConsole) => void) | null = null;

/** Délai maximal pour qu'un aperçu signale la fin de son chargement. */
export const DELAI_CHARGEMENT_MS = 4_000;
/**
 * Garde APRÈS le chargement avant de rendre le verdict : les erreurs d'une app
 * arrivent souvent au premier `requestAnimationFrame` ou au premier
 * `setTimeout`, pas pendant le chargement lui-même.
 */
export const GARDE_APRES_CHARGEMENT_MS = 1_500;
export const DELAI_EVAL_MS = 2_000;

/**
 * Branche l'écoute des messages, une seule fois. `onEntree` reçoit chaque ligne
 * de console de l'app ; le dernier rappel fourni gagne (le store se rebranche
 * sans dupliquer l'écouteur).
 */
export function installerEcouteApercu(onEntree: (e: EntreeConsole) => void): void {
  surEntree = onEntree;
  if (installe || typeof window === "undefined") return;
  installe = true;
  window.addEventListener("message", (e: MessageEvent) => {
    const m = lireMessageApercu(e.data);
    if (!m) return;
    // SEULE l'iframe enregistrée compte : la page monte deux arbres dont un seul
    // est affiché (voir `Apercu` dans studio.tsx). Un message d'une autre
    // fenêtre — ou arrivé après le démontage — ne doit ni doubler une ligne de
    // console, ni répondre à une évaluation à la place de l'aperçu réel.
    if (fenetreApercu === null || e.source !== fenetreApercu) return;
    if (m.type === "console") {
      surEntree?.(m.entree);
      return;
    }
    if (m.type === "charge") {
      versionsChargees.add(m.version);
      for (const a of attentesChargement.get(m.version) ?? []) {
        clearTimeout(a.minuteur);
        a.resoudre(true);
      }
      attentesChargement.delete(m.version);
      return;
    }
    const attente = attentesEval.get(m.id);
    if (!attente) return;
    clearTimeout(attente.minuteur);
    attentesEval.delete(m.id);
    attente.resoudre(m.ok ? { ok: true, valeur: m.valeur ?? "" } : { ok: false, erreur: m.erreur ?? "erreur inconnue" });
  });
}

/** Le composant qui monte l'iframe déclare sa fenêtre ici (et `null` au démontage). */
export function enregistrerFenetreApercu(fenetre: Window | null): void {
  fenetreApercu = fenetre;
}

/** Vrai si un aperçu est monté et peut recevoir des messages. */
export function apercuDisponible(): boolean {
  return fenetreApercu !== null;
}

/** Délai accordé au composant pour monter l'iframe après un `set()` du store (React rend après). */
export const DELAI_MONTAGE_MS = 1_000;

/**
 * Attend qu'une fenêtre d'aperçu soit enregistrée. Le store écrit l'app puis
 * demande le verdict dans la même microtâche ; React ne monte l'iframe qu'au
 * rendu suivant. Sans cette attente, le premier verdict dirait toujours
 * « aperçu non monté » — un faux négatif fabriqué par un ordre d'exécution.
 */
async function attendreFenetre(delaiMs = DELAI_MONTAGE_MS): Promise<Window | null> {
  const debut = Date.now();
  while (fenetreApercu === null && Date.now() - debut < delaiMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return fenetreApercu;
}

/** Une nouvelle version d'app va être rendue : on oublie ce qu'on savait de son numéro. */
export function preparerVersion(version: number): void {
  versionsChargees.delete(version);
}

/** Attend le `load` de cette version ; `false` si rien n'arrive dans le délai. */
export function attendreChargement(version: number, delaiMs = DELAI_CHARGEMENT_MS): Promise<boolean> {
  if (versionsChargees.has(version)) return Promise.resolve(true);
  return new Promise((resoudre) => {
    const attente: Attente<boolean> = {
      resoudre,
      minuteur: setTimeout(() => {
        const liste = attentesChargement.get(version) ?? [];
        attentesChargement.set(
          version,
          liste.filter((a) => a !== attente),
        );
        resoudre(false);
      }, delaiMs),
    };
    attentesChargement.set(version, [...(attentesChargement.get(version) ?? []), attente]);
  });
}

/**
 * Exécute `code` DANS l'aperçu (l'app a ses fonctions et son DOM) et rend le
 * résultat. `null` si aucun aperçu n'est monté ou s'il ne répond pas : le
 * critère sera « non vérifié », on n'exécute pas le code ailleurs à sa place.
 */
export async function evaluerDansApercu(code: string, delaiMs = DELAI_EVAL_MS): Promise<ResultatExecution | null> {
  const fenetre = await attendreFenetre();
  if (!fenetre) return null;
  const id = `e${++compteurEval}`;
  return new Promise((resoudre) => {
    const minuteur = setTimeout(() => {
      attentesEval.delete(id);
      resoudre(null);
    }, delaiMs);
    attentesEval.set(id, { resoudre, minuteur });
    try {
      fenetre.postMessage({ type: "studio:eval", id, code }, "*");
    } catch (e) {
      clearTimeout(minuteur);
      attentesEval.delete(id);
      resoudre({ ok: false, erreur: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  });
}

/**
 * LE VERDICT DE L'APERÇU pour une version : chargée ? puis, après la garde,
 * quelles erreurs console ont été émises par CETTE version. `entrees` est lu au
 * moment du verdict (le store les accumule pendant ce temps). `null` = aucun
 * aperçu monté : rien à juger.
 */
export async function verdictApercu(
  version: number,
  entrees: () => EntreeConsole[],
  options: { gardeMs?: number; delaiChargementMs?: number } = {},
): Promise<{ charge: boolean; erreurs: string[] } | null> {
  if ((await attendreFenetre()) === null) return null;
  const charge = await attendreChargement(version, options.delaiChargementMs ?? DELAI_CHARGEMENT_MS);
  if (charge) await new Promise((r) => setTimeout(r, options.gardeMs ?? GARDE_APRES_CHARGEMENT_MS));
  const erreurs = entrees()
    .filter((e) => e.version === version && e.niveau === "error")
    .map((e) => `${e.message}${e.ligne !== null ? ` (ligne ${e.ligne}${e.colonne !== null ? `:${e.colonne}` : ""})` : ""}`);
  return { charge, erreurs };
}
