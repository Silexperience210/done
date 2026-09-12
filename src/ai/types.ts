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

/**
 * ÉTAPES RÉELLEMENT TRAVERSÉES par le code pendant un chargement — nommées, pas
 * chiffrées. Sert à distinguer « occupé » de « bloqué » à l'écran : un
 * pourcentage qui n'avance plus ne dit pas si le moteur travaille ou s'il est
 * figé, alors que le nom de l'étape en cours, lui, ne peut être affiché que par
 * l'étape qui tourne vraiment.
 *
 * Chaque valeur correspond à un appel réel, indivisible côté JavaScript :
 *
 *  - `recherche_modele` : on interroge le disque (`stat`) aux emplacements où
 *    le moteur natif cherchera le GGUF (voir `chercherModele`, modeleLocal.ts).
 *  - `initialisation_moteur` : `initLlama` est en cours. CETTE étape réunit la
 *    lecture du GGUF ET la création du contexte : c'est UN SEUL appel natif,
 *    qui ne peut pas être découpé depuis ici. On ne prétend donc pas afficher
 *    « lecture » séparément d'« initialisation » — ce serait inventer une
 *    frontière que le code ne franchit pas.
 *  - `premier_calcul` : la première évaluation de prompt (premier appel de
 *    `completion`, dans `generer`).
 *  - `premier_jeton` : le premier jeton réellement rendu par le moteur.
 *  - `termine` : la génération est finie, la mesure est faite.
 */
export type EtapeChargement =
  | "recherche_modele"
  | "initialisation_moteur"
  | "premier_calcul"
  | "premier_jeton"
  | "termine";

/** Libellé d'affichage d'une étape — le SEUL endroit qui écrit du texte à l'écran. */
export function libelleEtape(etape: EtapeChargement): string {
  switch (etape) {
    case "recherche_modele":
      return "recherche du modèle sur le téléphone…";
    case "initialisation_moteur":
      return "lecture du modèle et initialisation du moteur…";
    case "premier_calcul":
      return "premier calcul…";
    case "premier_jeton":
      return "premier jeton reçu…";
    case "termine":
      return "terminé";
  }
}

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
  /**
   * ÉTAPE EN COURS, quand le code en est une. Facultative : tout appelant qui
   * n'en fournit pas reste valide, et l'affichage retombe alors sur la phase.
   * Voir `libelleEtape` : c'est ce qui permet d'écrire à l'écran « premier
   * calcul… » plutôt que de laisser un écran muet qui ressemble à un blocage.
   */
  etape?: EtapeChargement;
};

export type GenerateOptions = {
  system: string;
  history: { role: string; content: string }[];
  maxNewTokens?: number;
  onToken?: (text: string) => void;
  /**
   * Appelé UNE fois, à la fin de la génération, avec la mesure du débit.
   *
   * `jetons` est le COMPTE RÉEL rendu par le moteur (0 s'il ne le fournit pas),
   * jamais une estimation déduite d'une longueur de texte. `msDepuisPremier` est
   * la durée de décodage retenue : celle du moteur quand il la donne
   * (`timings.predicted_ms`), sinon la fenêtre relevée dans l'appli entre le
   * premier jeton et la fin de l'appel.
   *
   * Aucun appel n'a lieu quand rien de fiable n'a pu être mesuré : mieux vaut
   * pas de valeur qu'un 0,0 qui se fait passer pour une mesure.
   */
  onVitesse?: (tokParSeconde: number, jetons: number, msDepuisPremier: number) => void;
  /**
   * ÉTAPE réelle atteinte pendant la génération (« premier calcul », « premier
   * jeton », « terminé »). Facultative, purement informative : elle sert à
   * l'écran, qui peut dire ce que le moteur est en train de faire au lieu de
   * laisser un bloc vide impossible à distinguer d'un figement. Aucune durée
   * n'y est jamais annoncée.
   */
  onEtape?: (etape: EtapeChargement) => void;
  signal?: AbortSignal;
  /**
   * Schéma JSON (chaîne) contraignant la sortie vers un JSON valide. Le moteur
   * natif sait l'appliquer : llama.cpp le convertit en grammaire.
   */
  jsonSchema?: string;
  /** Grammaire GBNF de contrainte (natif). Prime sur `jsonSchema` si fournie. */
  grammar?: string;
};
