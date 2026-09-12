/**
 * LIVRAISON DU MODÈLE GGUF — le maillon qui manquait entre l'appli et le plugin.
 *
 * RAPPEL DU BUG (diagnostiqué dans le code du plugin, pas supposé). L'appli
 * embarquait le GGUF dans les assets de l'APK. Or `llama-cpp-capacitor` ne
 * cherche le modèle QUE sur le système de fichiers — `LlamaCpp.java`,
 * `getModelSearchPaths()` :
 *   getFilesDir()/<fichier>, getFilesDir()/Documents/<fichier>,
 *   getExternalFilesDir(null)/<fichier>, getExternalFilesDir(null)/Documents/<fichier>,
 *   /sdcard/Documents/<fichier>, /sdcard/Download/<fichier>, …
 * Aucun chemin d'assets, et le drapeau `is_model_asset` n'est lu NULLE PART côté
 * Android. Un GGUF posé dans les assets était donc introuvable → le natif
 * renvoyait « Failed to initialize native context ».
 *
 * CORRECTIF. L'appli TÉLÉCHARGE le GGUF au premier lancement dans
 * getFilesDir()/Documents/<fichier> — la 2e entrée de la liste ci-dessus — puis
 * passe au plugin le NOM DE FICHIER SEUL, qu'il résout tout seul.
 *
 * POURQUOI `@capacitor/filesystem`, ET SES LIMITES (vérifiées dans le paquet
 * installé, version 8.1.3 — pas dans une doc) :
 *  - `Directory.Data` → `c.filesDir` = getFilesDir()
 *    (`LegacyFilesystemImplementation.getDirectory`) ;
 *  - `path` relatif est joint à ce dossier (`File(filesDir, path)`), donc
 *    `path: "Documents/<fichier>"` écrit EXACTEMENT là où le natif regarde ;
 *  - MAIS `downloadFile` n'honore PAS l'option `recursive` et ne crée pas les
 *    dossiers parents : il faut créer `Documents/` AVANT, via `mkdir`. Sans lui,
 *    `FileOutputStream` échoue (« No such file or directory »). C'est un piège
 *    réel, pas une précaution de style ;
 *  - `downloadFile` est marqué déprécié en faveur de `@capacitor/file-transfer`,
 *    mais reste pleinement implémenté en 8.1.3. On l'utilise en connaissance de
 *    cause ; migrer vers `file-transfer` serait un changement d'API à part.
 *
 * Le plugin n'est PAS importé au chargement du module (le bundle navigateur et
 * les tests Node ne doivent pas en dépendre) : il est chargé par `import()`
 * dynamique à l'appel, ou INJECTÉ par les tests.
 */
import { modeleGguf, type ModeleGguf } from "./moteurNatif.ts";
import type { LocalModelId, ProgresChargement } from "./types.ts";

/**
 * `Directory.Data` de @capacitor/filesystem vaut la chaîne « DATA » ; sur Android
 * elle pointe sur getFilesDir(). On garde la valeur littérale (plutôt qu'un
 * import du paquet) pour que ce module reste chargeable sans Capacitor.
 */
const DOSSIER_DATA = "DATA";

/** Sous-dossier attendu par le plugin llama.cpp : getFilesDir()/Documents. */
const SOUS_DOSSIER = "Documents";

/**
 * Évènement « progress » du plugin Filesystem (contrat réel : `ProgressStatus`).
 * `contentLength` est le total annoncé par le serveur, `bytes` le cumul reçu.
 */
export type ProgresFichier = {
  url: string;
  bytes: number;
  contentLength: number;
};

/** Ce qu'on attend du plugin @capacitor/filesystem, réduit au strict nécessaire. */
export type PluginFichiers = {
  mkdir: (o: { path: string; directory: string; recursive?: boolean }) => Promise<unknown>;
  stat: (o: { path: string; directory: string }) => Promise<{ size: number }>;
  downloadFile: (o: {
    url: string;
    path: string;
    directory: string;
    progress?: boolean;
    recursive?: boolean;
  }) => Promise<{ path?: string }>;
  addListener: (
    event: "progress",
    cb: (p: ProgresFichier) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
};

/**
 * Tolérance de taille acceptée en vérification : 2 %. Un GGUF public fait
 * exactement `ModeleGguf.octets` ; on garde une petite marge pour survivre à une
 * ré-upload mineure du Hub, mais on refuse un fichier tronqué ou d'un autre
 * modèle.
 */
const TOLERANCE_TAILLE = 0.02;

/**
 * Ce qu'on donne au moteur natif comme `model` : le NOM DE FICHIER SEUL. Le
 * plugin Android le résout lui-même dans getFilesDir()/Documents/<fichier>.
 *
 * NE PAS renvoyer un chemin absolu : `LlamaCpp.initContext` n'en garde de toute
 * façon que `new File(modelPath).getName()`, et un chemin complet laisserait
 * croire qu'on maîtrise l'emplacement, ce qui n'est pas le cas.
 */
export function cheminModele(id: LocalModelId): string {
  return modeleGguf(id).fichier;
}

/**
 * Chemin RELATIF sous `Directory.Data`, tel qu'attendu par le plugin llama.cpp :
 * « Documents/<fichier> », c'est-à-dire getFilesDir()/Documents/<fichier>.
 */
export function cheminRelatif(id: LocalModelId): string {
  return `${SOUS_DOSSIER}/${modeleGguf(id).fichier}`;
}

/** Une taille est plausible si elle colle à la taille réelle du fichier (±2 %). */
export function taillePlausible(tailleVue: number, octetsAttendus: number): boolean {
  if (!Number.isFinite(tailleVue) || tailleVue <= 0) return false;
  return Math.abs(tailleVue - octetsAttendus) <= octetsAttendus * TOLERANCE_TAILLE;
}

/** Taille lisible pour un humain, en français (« 398 Mo », « 8,91 Go »). */
function tailleLisible(octets: number): string {
  if (octets >= 1e9) return `${(octets / 1e9).toFixed(2).replace(".", ",")} Go`;
  return `${Math.round(octets / 1e6)} Mo`;
}

/**
 * Le vrai plugin Capacitor, chargé à l'appel. `import()` dynamique : ce module
 * reste compilable et testable sans Capacitor, et le bundle navigateur ne tire
 * pas `@capacitor/filesystem`. Le contrat du plugin est plus large que
 * `PluginFichiers` ; on le restreint volontairement (même approche que pour le
 * plugin llama.cpp dans `moteurNatif.ts`).
 */
export async function pluginFichiersParDefaut(): Promise<PluginFichiers> {
  const { Filesystem } = await import("@capacitor/filesystem");
  return Filesystem as unknown as PluginFichiers;
}

/** Taille du fichier s'il existe, `null` sinon. `stat` rejette sur un absent :
 * ce n'est PAS une erreur, c'est le cas nominal avant le premier téléchargement. */
async function taillePresente(plugin: PluginFichiers, chemin: string): Promise<number | null> {
  try {
    const info = await plugin.stat({ path: chemin, directory: DOSSIER_DATA });
    return typeof info?.size === "number" ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Rend une erreur technique ACTIONNABLE pour l'utilisateur : on dit ce qu'il
 * faut FAIRE, jamais un code brut du moteur natif. Les erreurs déjà produites par
 * `telechargerModele` sont actionnables et traversent la fonction inchangées.
 */
export function messageErreurActionnable(brut: string, id?: LocalModelId): string {
  // Erreur brute du plugin llama.cpp quand le fichier du modèle n'est pas
  // trouvé/chargeable (LlamaCpp.java : « Failed to initialize native context »).
  // C'est précisément le symptôme d'une livraison ratée du modèle.
  if (/Failed to initialize native context|Model path is required|Model not found/i.test(brut)) {
    const nom = id ? ` « ${modeleGguf(id).nom} »` : "";
    return (
      `le moteur natif n'a pas pu ouvrir le fichier du modèle${nom}. ` +
      `Il est peut-être incomplet ou corrompu : relance le téléchargement du ` +
      `modèle (connexion Internet requise), en vérifiant qu'il reste assez ` +
      `d'espace libre sur le téléphone.`
    );
  }
  return brut;
}

/**
 * Livre le GGUF sur l'appareil, à l'endroit que le plugin natif visite vraiment,
 * et VÉRIFIE le résultat. Renvoie le nom de fichier à passer comme `model`.
 *
 * - No-op si le fichier est déjà présent ET de taille plausible (pas de
 *   re-téléchargement de 400 Mo à chaque lancement) ;
 * - `onProgres` reçoit la phase « telechargement » avec un pourcentage RÉEL
 *   (octets reçus / total annoncé), puis « pret » ;
 * - un échec n'est JAMAIS avalé : téléchargement raté, fichier introuvable ou
 *   taille incohérente lèvent une erreur qui dit quoi faire.
 *
 * @param plugin Injecté par les tests ; en production, le plugin Capacitor est
 *               chargé dynamiquement.
 */
export async function telechargerModele(
  id: LocalModelId,
  onProgres?: (p: ProgresChargement) => void,
  plugin?: PluginFichiers,
): Promise<string> {
  const modele: ModeleGguf = modeleGguf(id);
  const relatif = cheminRelatif(id);
  const dep = plugin ?? (await pluginFichiersParDefaut());
  const debut = Date.now();

  // 1) DÉJÀ LÀ ? On ne relance pas un téléchargement de centaines de Mo pour
  //    rien. La taille doit être plausible : un fichier tronqué est traité comme
  //    absent et re-téléchargé.
  const present = await taillePresente(dep, relatif);
  if (present !== null && taillePlausible(present, modele.octets)) {
    onProgres?.({ phase: "pret", pct: 100, fichier: modele.fichier, ecouleMs: 0 });
    return cheminModele(id);
  }

  // 2) CRÉER LE DOSSIER. `getFileObject` du plugin ne crée pas les dossiers
  //    parents et `downloadFile` ignore `recursive` : sans ce mkdir, le
  //    téléchargement échoue. mkdir échoue si le dossier existe déjà — on
  //    l'ignore, la vérification finale tranchera.
  try {
    await dep.mkdir({ path: SOUS_DOSSIER, directory: DOSSIER_DATA, recursive: true });
  } catch {
    /* dossier probablement déjà présent : sans conséquence, la suite vérifiera */
  }

  // 3) TÉLÉCHARGER, en remontant la progression RÉELLE. Les évènements
  //    « progress » sont globaux au plugin : on filtre sur l'URL de CE modèle.
  let retirer: (() => Promise<void>) | null = null;
  if (onProgres) {
    const handle = await dep.addListener("progress", (p) => {
      if (p.url !== modele.url) return;
      const total = p.contentLength > 0 ? p.contentLength : modele.octets;
      const pct = total > 0 ? Math.min(99, Math.floor((p.bytes / total) * 100)) : 0;
      onProgres({
        phase: "telechargement",
        pct,
        fichier: modele.fichier,
        ecouleMs: Date.now() - debut,
      });
    });
    retirer = () => handle.remove();
  }

  onProgres?.({ phase: "telechargement", pct: 0, fichier: modele.fichier, ecouleMs: 0 });
  try {
    await dep.downloadFile({
      url: modele.url,
      path: relatif,
      directory: DOSSIER_DATA,
      // `progress: true` déclenche les évènements « progress » écoutés ci-dessus.
      progress: Boolean(onProgres),
      recursive: true,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `le téléchargement de ${modele.nom} a échoué (${detail}). ` +
        `Vérifie que le téléphone est connecté à Internet et qu'il reste au moins ` +
        `${tailleLisible(modele.octets)} d'espace libre, puis relance le téléchargement.`,
    );
  } finally {
    if (retirer) await retirer().catch(() => {});
  }

  // 4) VÉRIFIER. Un téléchargement peut « réussir » en laissant un fichier
  //    tronqué : on refuse alors de faire croire que le modèle est prêt.
  const apres = await taillePresente(dep, relatif);
  if (apres === null) {
    throw new Error(
      `le fichier du modèle est introuvable après le téléchargement. ` +
        `Vérifie que le téléphone a de l'espace de stockage libre, puis relance.`,
    );
  }
  if (!taillePlausible(apres, modele.octets)) {
    throw new Error(
      `le fichier téléchargé fait ${tailleLisible(apres)} alors qu'il devrait faire ` +
        `${tailleLisible(modele.octets)} : le téléchargement est incomplet ou le fichier ` +
        `est corrompu. Relance le téléchargement (Wi-Fi conseillé, ${tailleLisible(modele.octets)}).`,
    );
  }

  onProgres?.({ phase: "pret", pct: 100, fichier: modele.fichier, ecouleMs: Date.now() - debut });
  return cheminModele(id);
}
