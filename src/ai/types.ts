/**
 * Types PARTAGÉS de l'inférence — neutres, sans aucune dépendance.
 *
 * Ce module existe pour que `moteur.ts`, `moteurNatif.ts` et `modeleLocal.ts`
 * partagent les mêmes types sans s'importer les uns les autres. Il remplace
 * l'ancien `localModel.ts`, qui portait le moteur NAVIGATEUR (transformers.js /
 * WebGPU) en plus de ces types : le moteur navigateur a été retiré du projet,
 * tout tourne désormais sur l'appareil via llama.cpp en natif.
 */

/**
 * Identifiant d'un étage de modèle. Aligné sur `MODELES_GGUF` (moteurNatif.ts)
 * et sur `MODELS` (lib/edge0.ts) : les trois listes désignent les mêmes modèles.
 */
export type LocalModelId = "coder3b" | "coder15" | "coder05";

/** Phases d'un chargement de modèle, dans l'ordre où elles arrivent. */
export type PhaseChargement = "telechargement" | "initialisation" | "pret";

export type ProgresChargement = {
  phase: PhaseChargement;
  /** 0-100, pertinent surtout en phase de téléchargement. */
  pct: number;
  fichier: string;
  /** Millisecondes écoulées : c'est CE chiffre qui prouve que ça travaille. */
  ecouleMs: number;
  /**
   * Octets déjà reçus, en phase « telechargement ». Vient du champ `bytes` de
   * l'évènement `progress` du plugin Filesystem (`ProgressStatus` : `{ url,
   * bytes, contentLength }` — vérifié dans le paquet installé 8.1.3, il n'y a
   * AUCUN pourcentage dedans, on le calcule). Quand l'évènement reste muet,
   * c'est la surveillance périodique du fichier qui le remplit : l'interface a
   * toujours de quoi afficher « 430 Mo / 986 Mo » au lieu d'un écran figé.
   */
  octetsRecus?: number;
  /**
   * Taille totale annoncée, en octets (« contentLength » du même évènement).
   * Absente si le serveur ne l'annonce pas : on retombe alors sur la taille
   * connue du GGUF.
   */
  octetsTotal?: number;
};

export type GenerateOptions = {
  system: string;
  history: { role: string; content: string }[];
  maxNewTokens?: number;
  onToken?: (text: string) => void;
  /** Appelé à chaque jeton avec la vitesse instantanée mesurée, en tok/s. */
  onVitesse?: (tokParSeconde: number, jetons: number, msDepuisPremier: number) => void;
  signal?: AbortSignal;
  /**
   * Schéma JSON (chaîne) contraignant la sortie vers un JSON valide. Le moteur
   * natif sait l'appliquer : llama.cpp le convertit en grammaire.
   */
  jsonSchema?: string;
  /** Grammaire GBNF de contrainte (natif). Prime sur `jsonSchema` si fournie. */
  grammar?: string;
};
