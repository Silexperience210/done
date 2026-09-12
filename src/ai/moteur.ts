/**
 * Contrat du moteur d'inférence — UN SEUL moteur : llama.cpp en natif.
 *
 * L'inférence tourne exclusivement sur l'appareil, via le plugin Capacitor
 * `llama-cpp-capacitor` (voir `moteurNatif.ts`). L'ancien moteur NAVIGATEUR
 * (transformers.js / WebGPU / onnxruntime) a été retiré : une WebView Android
 * n'expose pas WebGPU, l'appli retombait sur du WebAssembly mono-thread, et les
 * poids ONNX n'avaient aucune raison d'exister à côté du GGUF natif.
 *
 * Le reste de l'application (la boucle d'agent, les outils, la mémoire) ne
 * connaît que `Moteur` : il ignore tout de llama.cpp et du plugin.
 *
 * Ce fichier n'importe que des TYPES (`./types.ts`) : aucun code lourd, et il
 * reste testable sans navigateur ni téléphone.
 */
import type { GenerateOptions, LocalModelId, ProgresChargement } from "./types.ts";

/** Un seul moteur possible désormais : le natif. */
export type NomMoteur = "natif";

export type Moteur = {
  nom: NomMoteur;
  charger: (id: LocalModelId, onProgres?: (p: ProgresChargement) => void) => Promise<void>;
  generer: (options: GenerateOptions) => Promise<string>;
  pret: () => boolean;
};

/** Ce qu'on lit de la globale `Capacitor` — réduit au strict nécessaire. */
type SourceCapacitor = {
  Capacitor?: { isNativePlatform?: () => boolean };
};

/**
 * Analyse PURE et injectable : on lui passe un objet, jamais la planète entière.
 *
 * On exige que `isNativePlatform()` réponde STRICTEMENT `true` : la seule
 * présence de l'objet `Capacitor` ne suffit PAS. Dans un navigateur, le shim
 * Capacitor peut exister et répondre `false` ; se fier à sa véracité évite de
 * tenter le moteur natif — et donc de faire import() le plugin llama.cpp — dans
 * une page web où il est absent.
 */
export function detecterNative(source: SourceCapacitor): boolean {
  return (
    typeof source.Capacitor?.isNativePlatform === "function" &&
    source.Capacitor.isNativePlatform() === true
  );
}

/**
 * Détection réelle dans l'environnement courant. On lit les globales plutôt que
 * d'importer `@capacitor/core` : le même code tourne dans l'APK et dans les
 * tests Node, sans charger Capacitor.
 */
export function estApplicationNative(): boolean {
  return detecterNative(globalThis as SourceCapacitor);
}
