/**
 * RÉGLAGES DU MOTEUR, CHOISIS PAR L'UTILISATEUR.
 *
 * POURQUOI CE MODULE EXISTE : le contexte (`n_ctx`) était figé à 4096, le lot de
 * pré-remplissage à 512 et les threads calculés tout seuls. Or c'est LÀ que se
 * joue la différence entre « le modèle charge » et « le modèle ne charge pas » :
 * sur un téléphone de 12 Go avec un modèle de 8 Go, chaque millier de jetons de
 * contexte coûte ~96 Mo de cache KV. Pouvoir descendre à 2048 jetons peut être
 * exactement ce qui fait tenir le 30B.
 *
 * Le cache KV n'est PAS estimé au doigt mouillé : il est calculé à partir des
 * paramètres RÉELS du modèle, relevés dans les en-têtes GGUF des trois fichiers
 * (`attention.head_count_kv`, `block_count`, `attention.key_length` — voir le
 * champ `kv` de `MODELES_GGUF`). Pour le 30B-A3B : 48 couches, 4 têtes KV,
 * 128 de dimension par tête.
 */
import { modeleGguf, type ModeleGguf } from "./moteurNatif.ts";
import type { LocalModelId } from "./types.ts";

export type ReglagesMoteur = {
  /** Taille du contexte, en jetons. */
  nCtx: number;
  /** Jetons traités par lot de pré-remplissage. */
  nBatch: number;
  /** Threads de calcul ; 0 = automatique (moitié des processeurs, borné à 6). */
  nThreads: number;
};

/** Les valeurs par défaut, celles qui marchaient avant que ce soit réglable. */
export const REGLAGES_DEFAUT: ReglagesMoteur = { nCtx: 4096, nBatch: 512, nThreads: 0 };

export const CHOIX_CONTEXTE = [2048, 4096, 8192, 16384, 32768] as const;
export const CHOIX_LOT = [128, 256, 512, 1024] as const;
export const CHOIX_THREADS = [0, 2, 3, 4, 5, 6] as const;

const CLE_STOCKAGE = "studio.reglages-moteur";
const CTX_MINI = 512;

/**
 * Octets de cache KV pour un contexte donné : n_ctx × couches × têtes KV ×
 * dimension par tête × 2 (clé ET valeur) × 2 (f16).
 *
 * C'est ce qui doit tenir en mémoire EN PLUS des poids du modèle : 96 Mo par
 * millier de jetons sur le 30B-A3B, 12 Mo sur le 0,5B.
 */
export function memoireKVOctets(modele: LocalModelId | ModeleGguf, nCtx: number): number {
  const m = typeof modele === "string" ? modeleGguf(modele) : modele;
  return nCtx * m.kv.couches * m.kv.tetesKV * m.kv.dimensionTete * 2 * 2;
}

/** Poids du GGUF + cache KV : ce que le moteur occupera vraiment. */
export function memoireTotaleOctets(modele: LocalModelId | ModeleGguf, nCtx: number): number {
  const m = typeof modele === "string" ? modeleGguf(modele) : modele;
  return m.octets + memoireKVOctets(m, nCtx);
}

export function contexteMax(modele: LocalModelId | ModeleGguf): number {
  const m = typeof modele === "string" ? modeleGguf(modele) : modele;
  return m.kv.contexteMax;
}

/** Ramène un contexte demandé à une valeur PROPOSÉE, et sous le maximum du modèle. */
export function contexteValide(demande: number, modele: LocalModelId | ModeleGguf): number {
  const max = contexteMax(modele);
  const proposes = CHOIX_CONTEXTE.filter((c) => c <= max);
  if (proposes.length === 0) return Math.min(CTX_MINI, max);
  if (proposes.includes(demande as (typeof CHOIX_CONTEXTE)[number])) return demande;
  if (demande > max) return proposes[proposes.length - 1];
  // Sinon : la plus grande valeur proposée qui ne dépasse pas la demande.
  const inferieures = proposes.filter((c) => c <= demande);
  return inferieures.length > 0 ? inferieures[inferieures.length - 1] : proposes[0];
}

/**
 * Rend des réglages TOUJOURS utilisables, quoi qu'on lui donne : valeur corrompue
 * dans le stockage, contexte plus grand que ce que le modèle accepte, lot nul…
 * Un moteur qui refuse de démarrer à cause d'un réglage illisible serait le pire
 * des échecs : l'utilisateur ne pourrait même plus revenir en arrière.
 */
export function normaliserReglages(brut: unknown, modele: LocalModelId): ReglagesMoteur {
  const b = (typeof brut === "object" && brut !== null ? brut : {}) as Partial<ReglagesMoteur>;
  const nCtx = contexteValide(typeof b.nCtx === "number" && Number.isFinite(b.nCtx) ? b.nCtx : REGLAGES_DEFAUT.nCtx, modele);
  const nBatch = CHOIX_LOT.includes(b.nBatch as (typeof CHOIX_LOT)[number]) ? (b.nBatch as number) : REGLAGES_DEFAUT.nBatch;
  const nThreads = CHOIX_THREADS.includes(b.nThreads as (typeof CHOIX_THREADS)[number])
    ? (b.nThreads as number)
    : REGLAGES_DEFAUT.nThreads;
  // Un lot plus grand que le contexte n'a pas de sens : chaque lot est un morceau
  // du prompt. On le borne plutôt que de laisser le moteur refuser.
  return { nCtx, nBatch: Math.min(nBatch, nCtx), nThreads };
}

/** Les réglages enregistrés pour ce modèle (ou les défauts). Ne lève jamais. */
export function lireReglages(modele: LocalModelId): ReglagesMoteur {
  try {
    if (typeof localStorage === "undefined") return normaliserReglages(REGLAGES_DEFAUT, modele);
    const brut = localStorage.getItem(CLE_STOCKAGE);
    if (!brut) return normaliserReglages(REGLAGES_DEFAUT, modele);
    return normaliserReglages(JSON.parse(brut), modele);
  } catch {
    // Stockage illisible (mode privé, quota, JSON cassé) : on repart des défauts
    // plutôt que d'empêcher l'appli de fonctionner.
    return normaliserReglages(REGLAGES_DEFAUT, modele);
  }
}

/** Enregistre les réglages. Ne lève jamais : l'appli doit continuer à marcher. */
export function ecrireReglages(reglages: ReglagesMoteur): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(CLE_STOCKAGE, JSON.stringify(reglages));
  } catch {
    /* stockage refusé : les réglages vivent alors le temps de la session */
  }
}
