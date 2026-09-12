/**
 * LA TRACE DU NATIF, LUE DEPUIS L'APPLI — parce que logcat est inaccessible.
 *
 * POURQUOI CE MODULE EXISTE : le plugin natif ne raconte ce qu'il fait que dans
 * `logcat`, et `logcat` n'est lisible qu'avec `adb` (câble USB) ou un rapport de
 * bug. Sur l'appareil visé, ni l'un ni l'autre n'est disponible — et c'est
 * exactement le cas de figure où l'on en a besoin : un chargement qui ne rend
 * JAMAIS la main ne laisse aucun message d'erreur, aucun crash, rien à l'écran.
 *
 * Le patch natif `patches/llama-cpp-capacitor+0.1.5+003+diagnostic-natif.patch`
 * écrit donc chaque étape du chargement dans `journal-natif.txt`, dans la
 * mémoire privée de l'appli (`getFilesDir()`, le dossier `Directory.Data` de
 * Capacitor). Ce module le relit, et `trace-native.tsx` l'affiche.
 *
 * CE QUE LA TRACE PERMET DE TRANCHER, et c'est tout l'intérêt :
 *   - fichier absent       -> le blocage est AVANT le natif, côté Java
 *                             (`getModelSearchPaths` : sondage du stockage) ;
 *   - « entrée » puis rien -> blocage dans la recherche du fichier (les `exists()`)
 *                             ou juste après ;
 *   - « appel de loadModel » puis rien -> blocage dans la lecture/initialisation
 *                             native (mmap, contexte, cache KV, warmup).
 * Aucun autre instrument disponible sur ce téléphone ne sépare ces trois cas.
 *
 * SANS CAPACITOR (navigateur, tests Node, rendu statique) : la lecture échoue et
 * on le dit — l'échec n'est pas une exception qui remonte.
 */

/** Nom EXACT écrit par le natif (jni.cpp, fonction `diag`). */
export const FICHIER_TRACE_NATIVE = "journal-natif.txt";

/**
 * `Directory.Data` de Capacitor pointe sur `getFilesDir()` : c'est le dossier où
 * le natif écrit la trace, et le même que le reste de l'appli utilise pour le
 * modèle (`modeleLocal.ts`). Il est demandé à l'énumération du paquet au moment
 * de la lecture (import dynamique) — aucune chaîne recopiée ici.
 */

export type EtatTraceNative = {
  /** Vrai si le fichier a été lu (même vide). */
  presente: boolean;
  /** Contenu intégral, lignes horodatées, dans l'ordre d'écriture. */
  texte: string;
  /** Message d'erreur brut quand la lecture a échoué (diagnostic). */
  erreur: string | null;
};

/** La trace native, telle qu'elle est sur le disque, à cet instant. */
export async function lireTraceNative(): Promise<EtatTraceNative> {
  try {
    // Les ÉNUMÉRATIONS viennent du paquet, pas de chaînes recopiées : c'est ce
    // que le type de `readFile` attend, et « DATA »/« utf8 » écrits à la main ne
    // sont pas vérifiables par le compilateur.
    const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
    const lu = await Filesystem.readFile({
      path: FICHIER_TRACE_NATIVE,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    const texte = typeof lu.data === "string" ? lu.data : "";
    return { presente: true, texte, erreur: null };
  } catch (e) {
    // « fichier absent » est une INFORMATION, pas une panne : elle dit que le
    // natif n'a jamais été atteint. On ne la confond pas avec une erreur de
    // lecture, d'où le texte brut conservé tel quel.
    return {
      presente: false,
      texte: "",
      erreur: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Les N dernières lignes utiles (le début n'a plus d'intérêt une fois qu'on
 * cherche où ça s'arrête). `null` quand la trace n'existe pas.
 */
export function dernieresLignes(trace: EtatTraceNative, n = 40): string[] | null {
  if (!trace.presente) return null;
  const lignes = trace.texte.split("\n").filter((l) => l.trim() !== "");
  return lignes.slice(-n);
}
