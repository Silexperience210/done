/**
 * Point d'entrée UNIQUE de l'inférence — deux moteurs possibles.
 *
 * Pourquoi cette abstraction : dans le navigateur, le moteur est WebGPU et il est
 * plafonné en mémoire (le Coder 1.5B, 1,3 Go, ne démarre pas sur le téléphone ;
 * le 0,5B tourne à 5 tok/s mesurés). Dans l'APK, l'inférence passe par llama.cpp
 * en natif, avec déport GPU — c'est le seul moyen d'utiliser la RAM réelle du
 * téléphone et de monter d'étage de modèle.
 *
 * Le reste de l'application (la boucle d'agent, les outils, la mémoire) ne doit
 * RIEN savoir de ce choix : il ne connaît que `Moteur`.
 *
 * Ce fichier n'importe que des TYPES depuis `localModel.ts` : aucun code lourd
 * n'est chargé, et il reste testable sans navigateur.
 */
import type { GenerateOptions, LocalModelId, ProgresChargement } from "./localModel.ts";

export type NomMoteur = "webgpu" | "natif";

export type Moteur = {
  nom: NomMoteur;
  charger: (id: LocalModelId, onProgres?: (p: ProgresChargement) => void) => Promise<void>;
  generer: (options: GenerateOptions) => Promise<string>;
  pret: () => boolean;
};

export type Capacites = {
  /** On tourne dans l'appli empaquetée (Capacitor), donc llama.cpp est disponible. */
  applicationNative: boolean;
  /** Le navigateur expose un GPU utilisable. Nécessaire seulement hors APK. */
  webgpu: boolean;
};

/** Analyse injectable : on lui passe un objet, jamais la planète entière. */
export function detecterCapacites(source: {
  capacitor?: unknown;
  gpu?: unknown;
}): Capacites {
  return {
    applicationNative: Boolean(source.capacitor),
    webgpu: Boolean(source.gpu),
  };
}

/**
 * Le natif gagne dès qu'il est là : c'est llama.cpp sur le matériel du téléphone,
 * sans le plafond mémoire de WebGPU. WebGPU n'est que le repli du navigateur.
 */
export function choisirMoteur(c: Capacites): NomMoteur {
  return c.applicationNative ? "natif" : "webgpu";
}

/**
 * Détection réelle dans l'environnement courant. On lit les globales plutôt que
 * d'importer `@capacitor/core` : le même code tourne dans le navigateur, dans
 * l'APK, et dans les tests Node.
 */
export function capacitesReelles(): Capacites {
  const g = globalThis as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
    navigator?: { gpu?: unknown };
  };
  const natif = typeof g.Capacitor?.isNativePlatform === "function" && g.Capacitor.isNativePlatform() === true;
  return detecterCapacites({ capacitor: natif, gpu: g.navigator?.gpu });
}
