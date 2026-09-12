/**
 * DOUBLURE de `localModel.ts` pour le build STATIQUE destiné à l'APK
 * (`npm run build:spa`, `BUILD_SPA=1`).
 *
 * POURQUOI ELLE EXISTE. Dans l'appli empaquetée, `capacitesReelles()` voit
 * Capacitor et `choisirMoteur` renvoie TOUJOURS « natif » : la branche
 * navigateur (WebGPU / transformers.js) est du code MORT. Elle tirait pourtant
 * dans le bundle statique `@huggingface/transformers` et `onnxruntime-node` —
 * ~21 Mo de WASM (ort-wasm-simd-threaded.asyncify-*.wasm) et 4 alertes de
 * sécurité graves (adm-zip, sharp/libvips) — pour rien.
 *
 * COMMENT. `vite.config.ts` alias `@/ai/localModel` vers CE fichier quand
 * `BUILD_SPA=1`. Le seul import RUNTIME de `localModel.ts` est le `import()`
 * dynamique du store (`chargerMoteurWebgpu`, jamais atteint en natif) ; tout le
 * reste n'importe que des TYPES, effacés à la compilation. Aliaser le module
 * suffit donc à sortir toute la chaîne transformers/onnxruntime du graphe,
 * sans que le build navigateur (`npm run build`) change d'un iota — il n'est
 * pas soumis à l'alias.
 *
 * Si ce module était un jour CHARGÉ, c'est que le build SPA exécuterait la
 * branche navigateur : on échoue alors FORT et clairement, plutôt que de servir
 * une librairie absente.
 */
const ABSENT =
  "le moteur navigateur (transformers.js / WebGPU) n'est pas embarqué dans l'APK : " +
  "la version empaquetée utilise llama.cpp en natif (plugin llama-cpp-capacitor).";

/** Jamais appelé en SPA ; présent pour que l'alias expose la même forme. */
export function loadModel(): Promise<never> {
  return Promise.reject(new Error(ABSENT));
}

/** Jamais appelé en SPA. */
export function generate(): Promise<never> {
  return Promise.reject(new Error(ABSENT));
}

/** Jamais appelé en SPA. */
export function metrics(): never {
  throw new Error(ABSENT);
}
