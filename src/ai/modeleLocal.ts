/**
 * LIVRAISON DU MODÈLE GGUF — charger D'ABORD, télécharger seulement en secours.
 *
 * ORDRE (c'est le correctif de ce fichier) : `charger` → `telecharger` →
 * `charger`. Le moteur natif N'A PAS BESOIN que l'appli télécharge quoi que ce
 * soit : `llama-cpp-capacitor` cherche le GGUF par son NOM DE FICHIER dans huit
 * emplacements — `LlamaCpp.java:1095`, `getModelSearchPaths()` :
 *   getFilesDir()/<fichier>, getFilesDir()/Documents/<fichier>,
 *   getExternalFilesDir(null)/<fichier>, getExternalFilesDir(null)/Documents/<fichier>,
 *   /sdcard/Documents/<fichier>, /sdcard/Download/<fichier>,
 *   /sdcard/Downloads/<fichier>, /sdcard/Downloads/models/<fichier>.
 * Et `jni.cpp:185-200` (`initContextNative`) essaie ces chemins dans l'ordre et
 * s'arrête au premier fichier existant. Un GGUF déposé par l'utilisateur dans
 * Download est donc TROUVÉ ET CHARGÉ sans qu'une ligne de code applicatif s'en
 * mêle. Télécharger avant de charger faisait d'un téléchargement cassé un
 * blocage TOTAL : plus rien ne marchait, même avec le fichier sous la main.
 *
 * Ce qui reste VRAI du diagnostic d'origine : le plugin ne cherche JAMAIS dans
 * les assets de l'APK (aucun chemin d'assets dans la liste ci-dessus, et le
 * drapeau `is_model_asset` n'est lu NULLE PART côté Android). Un GGUF embarqué
 * était donc introuvable → le natif rendait « Failed to initialize native
 * context ». Le téléchargement par l'appli reste un CONFORT, pas un prérequis.
 *
 * CE QU'ON PASSE AU PLUGIN : le NOM DE FICHIER SEUL (`cheminModele`), jamais un
 * chemin absolu. `LlamaCpp.initContext` n'en garde de toute façon que
 * `new File(modelPath).getName()` (LlamaCpp.java:508), puis le natif cherche ce
 * nom dans sa propre liste.
 *
 * POURQUOI `@capacitor/filesystem`, ET SES LIMITES (vérifiées dans le paquet
 * installé, version 8.1.3 — pas dans une doc) :
 *  - `Directory.Data` → `c.filesDir` = getFilesDir()
 *    (`LegacyFilesystemImplementation.kt:50-60`, `getDirectory`) ;
 *  - `downloadFile` en 8.1.3 passe par ce même code legacy et ACCEPTE un
 *    sous-dossier dans `path` : `getFileObject` rend `File(filesDir, path)`
 *    (`LegacyFilesystemImplementation.kt:62-81`), donc
 *    `path: "Documents/<fichier>"` désigne bien getFilesDir()/Documents/<fichier>
 *    — la 2e entrée de la liste de recherche du natif. Le sous-dossier n'est
 *    donc PAS la cause d'un téléchargement qui ne démarre pas ; c'est vérifié
 *    dans les sources installées, pas supposé ;
 *  - MAIS `downloadFile` n'honore PAS l'option `recursive` et ne crée pas les
 *    dossiers parents : il faut créer `Documents/` AVANT, via `mkdir`. Sans lui,
 *    `FileOutputStream(file, false)` (ligne 120) échoue (« No such file or
 *    directory »). C'est un piège réel, pas une précaution de style ;
 *  - `downloadFile` est marqué déprécié en faveur de `@capacitor/file-transfer`,
 *    mais reste pleinement implémenté en 8.1.3. On l'utilise en connaissance de
 *    cause ; migrer vers `file-transfer` serait un changement d'API à part.
 *
 * PROGRESSION — le contrat, lu dans le paquet installé et dans le Kotlin, pas
 * supposé (`dist/esm/definitions.d.ts:493-512`, `ProgressStatus`) :
 *   `{ url: string, bytes: number, contentLength: number }`
 * Il n'y a AUCUN champ de pourcentage : il se calcule (`bytes / contentLength`).
 * L'émetteur Kotlin (`FilesystemPlugin.kt:258-264`) pose `url` = l'URL PASSÉE à
 * `downloadFile` (pas l'URL après redirection du CDN) et `contentLength` = le
 * `content-length` de la réponse — mis à 0 quand il dépasse un `Int` (donc pour
 * le 30B de 8 Go, où `toInt()` lève) : d'où le repli sur `modele.octets`.
 * L'évènement est diffusé toutes les 100 ms au plus (`minEmitIntervalMillis`).
 *
 * Comme ce canal peut rester muet sur un appareil, la progression est DOUBLÉE
 * par une surveillance de la taille du fichier sur le disque : c'est ce second
 * canal, indépendant des évènements, qui garantit un affichage qui avance et un
 * délai de garde honnête (voir `DELAI_GARDE_MS`).
 *
 * Le plugin n'est PAS importé au chargement du module (le bundle navigateur et
 * les tests Node ne doivent pas en dépendre) : il est chargé par `import()`
 * dynamique à l'appel, ou INJECTÉ par les tests.
 */
import { modeleGguf, type ModeleGguf } from "./moteurNatif.ts";
import type { LocalModelId, ProgresChargement } from "./types.ts";
// LA TRACE (voir journal.ts) : les étapes de livraison y sont écrites AVANT
// d'être tentées, pour qu'un téléchargement qui ne rend jamais la main laisse
// une dernière ligne utilisable.
import { journaliser, noter } from "./journal.ts";

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
  /** Sert à effacer un fichier partiel : sans lui, un échec laisse 400 Mo morts. */
  deleteFile?: (o: { path: string; directory: string }) => Promise<void>;
  downloadFile: (o: {
    url: string;
    path: string;
    directory: string;
    progress?: boolean;
    recursive?: boolean;
    /** Attente maximale de l'ÉTABLISSEMENT de la connexion (ms). */
    connectTimeout?: number;
    /** Attente maximale entre deux paquets reçus (ms), réarmée à chaque lecture. */
    readTimeout?: number;
  }) => Promise<{ path?: string }>;
  addListener: (
    event: "progress",
    cb: (p: ProgresFichier) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
};

/**
 * DÉLAI DE GARDE — 60 s sans le moindre octet nouveau et on le DIT.
 *
 * Sans lui, un téléchargement qui cale (Wi-Fi qui tombe, serveur qui ne répond
 * plus) laisse un écran mort, indiscernable d'un plantage : c'est exactement le
 * défaut qui avait déjà été corrigé côté navigateur, et il ne doit pas revenir.
 * Le garde est mesuré sur les OCTETS (évènement `progress` ET taille du fichier
 * sur le disque, la plus avancée des deux) — jamais sur une horloge de durée
 * totale, sinon un gros modèle sur une connexion lente serait tué à tort.
 */
export const DELAI_GARDE_MS = 60_000;

/**
 * DÉLAIS HTTP CÔTÉ NATIF — sans eux, un téléchargement calé ne finit JAMAIS.
 *
 * Preuve, lue dans les sources installées (pas une précaution de style) :
 *  - `LegacyFilesystemImplementation.kt:92-93` lit `connectTimeout`/`readTimeout`
 *    dans les options de l'appel et les passe au constructeur de connexion ;
 *  - `HttpRequestHandler.java:112-113` (@capacitor/android) ne les applique que
 *    s'ils sont NON NULS : `if (connectTimeout != null) …`. Absents, la connexion
 *    garde les valeurs par défaut de `HttpURLConnection`, soit **0 = attendre
 *    indéfiniment**. Un socket qui cesse de livrer des octets bloque alors le fil
 *    de téléchargement (`thread { … }`, même fichier, lignes 31-39) pour toujours :
 *    ni succès, ni rejet, donc aucun message à l'écran.
 *
 * `LECTURE_MS` est volontairement INFÉRIEUR à `DELAI_GARDE_MS` : on veut que le
 * natif abandonne le premier, ce qui libère vraiment le socket et le
 * `FileOutputStream` ; le délai de garde JS reste le filet de sécurité au cas où
 * le natif ne rendrait pas la main (il ne peut pas être interrompu depuis ici).
 */
export const DELAIS_HTTP = { CONNEXION_MS: 20_000, LECTURE_MS: 45_000 } as const;

/** Options injectables : les tests pilotent l'horloge et la minuterie. */
export type OptionsLivraison = {
  /** Délai sans nouvel octet avant d'abandonner (défaut : 60 s). */
  delaiGardeMs?: number;
  /** Horloge en millisecondes (tests). */
  maintenant?: () => number;
  /**
   * Planificateur d'intervalle (tests) : reçoit la fonction à appeler et la
   * période, et rend la fonction d'annulation. Par défaut `setInterval`.
   */
  planifier?: (cb: () => void, ms: number) => () => void;
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
 * OÙ LE MOTEUR NATIF CHERCHE LE GGUF — la liste RÉELLE, lue dans le plugin
 * (`LlamaCpp.java:1095-1122`, `getModelSearchPaths`) et pas devinée. Les huit
 * entrées, dans l'ordre où le natif les essaie et s'arrête au premier fichier
 * existant (`jni.cpp:185-200`) :
 *
 *  1. getFilesDir()/<fichier>                    → `Directory.DATA`
 *  2. getFilesDir()/Documents/<fichier>          → `Directory.DATA` + Documents/
 *  3. getExternalFilesDir(null)/<fichier>        → `Directory.EXTERNAL`
 *  4. getExternalFilesDir(null)/Documents/<fichier>
 *  5. /sdcard/Documents/<fichier>                → `Directory.DOCUMENTS`
 *  6. /sdcard/Download/<fichier>                 → `Directory.EXTERNAL_STORAGE`
 *  7. /sdcard/Downloads/<fichier>
 *  8. /sdcard/Downloads/models/<fichier>
 *
 * ON VÉRIFIE LES HUIT, avec `stat`, parce que c'est le seul moyen de répondre à
 * la question qui compte quand le moteur dit « Failed to initialize native
 * context » : le fichier est-il LÀ, où, et de quelle taille ? Le natif, lui, ne
 * dit jamais lequel des huit il a pris.
 */
export type EmplacementModele = {
  /** Chemin tel qu'on l'écrirait à la main sur le téléphone. */
  chemin: string;
  /** Valeur du `Directory` du plugin, pour refaire l'appel `stat`. */
  directory: string;
  /** Chemin passé au plugin, relatif à `directory`. */
  path: string;
  /** Taille vue par `stat` ; `null` si le fichier n'est pas là. */
  octets: number | null;
  /**
   * TROIS ÉTATS, pas deux — et la distinction est utile : « absent » se comble
   * en téléchargeant le fichier, « refusé » (permission, stockage non monté) ne
   * se comble PAS en téléchargeant. Les confondre ferait chercher au mauvais
   * endroit.
   */
  etat: "present" | "absent" | "refuse";
  /** Erreur BRUTE du `stat` quand il a échoué autrement que par « absent ». */
  erreur: string | null;
};

export type EtatFichierModele = {
  /** Les huit emplacements, dans l'ordre du moteur, avec leur état. */
  emplacements: EmplacementModele[];
  /** Ceux où un fichier existe réellement (au moins un là où il doit être). */
  trouves: EmplacementModele[];
};

/**
 * `EXTERNAL` n'est pas une valeur de `Directory` documentée comme publique mais
 * elle EST reconnue par le plugin (`LegacyFilesystemImplementation.getDirectory`
 * : `"EXTERNAL" -> context.getExternalFilesDir(null)`), et c'est exactement
 * getExternalFilesDir(null) — l'emplacement 3 des chemins du natif.
 */
export const EMPLACEMENTS_MODELE: readonly {
  directory: string;
  prefixe: string;
  dossier: string;
}[] = [
  { directory: DOSSIER_DATA, prefixe: "", dossier: "mémoire de l'appli" },
  { directory: DOSSIER_DATA, prefixe: `${SOUS_DOSSIER}/`, dossier: "mémoire de l'appli / Documents" },
  { directory: "EXTERNAL", prefixe: "", dossier: "mémoire externe de l'appli" },
  {
    directory: "EXTERNAL",
    prefixe: `${SOUS_DOSSIER}/`,
    dossier: "mémoire externe de l'appli / Documents",
  },
  { directory: "DOCUMENTS", prefixe: "", dossier: "/sdcard/Documents" },
  { directory: "EXTERNAL_STORAGE", prefixe: "Download/", dossier: "/sdcard/Download" },
  { directory: "EXTERNAL_STORAGE", prefixe: "Downloads/", dossier: "/sdcard/Downloads" },
  {
    directory: "EXTERNAL_STORAGE",
    prefixe: "Downloads/models/",
    dossier: "/sdcard/Downloads/models",
  },
];

/** Le `stat` a répondu « pas là » (et non « je n'ai pas le droit »). */
function estAbsence(message: string): boolean {
  // « OS-PLUG-FILE-0008 » est le code RÉEL du plugin pour ce cas, et son message
  // est « 'stat' failed because file at '…' does not exist. »
  // (`FilesystemErrors.kt`, `doesNotExist`) : c'est le cas NORMAL quand le
  // fichier n'a pas encore été téléchargé, pas une erreur.
  return (
    /OS-PLUG-FILE-0008/.test(message) ||
    /no such file|does not exist|not exist|ENOENT|not found|introuvable|absent|cannot find|no files/i.test(
      message,
    )
  );
}

/**
 * DEMANDE OÙ EST LE FICHIER, AUX HUIT EMPLACEMENTS DU MOTEUR, ET DE QUELLE
 * TAILLE. C'est un DIAGNOSTIC : rien ici ne décide du chargement, et aucun de
 * ces `stat` ne peut faire échouer quoi que ce soit (chacun est encapsulé).
 *
 * Ne lève jamais : si le plugin fichiers lui-même est indisponible, on le rend
 * sous forme de refus explicites — une trace qui dit « je n'ai pas pu vérifier »
 * vaut mieux qu'une trace muette.
 */
export async function chercherModele(
  id: LocalModelId,
  plugin?: PluginFichiers,
): Promise<EtatFichierModele> {
  const modele = modeleGguf(id);
  const emplacements: EmplacementModele[] = [];
  let dep: PluginFichiers;
  try {
    dep = plugin ?? (await pluginFichiersParDefaut());
  } catch (e) {
    const erreur = `plugin fichiers indisponible : ${texteErreur(e)}`;
    return {
      emplacements: EMPLACEMENTS_MODELE.map((e) => ({
        chemin: `${e.dossier}/${modele.fichier}`,
        directory: e.directory,
        path: `${e.prefixe}${modele.fichier}`,
        octets: null,
        etat: "refuse" as const,
        erreur,
      })),
      trouves: [],
    };
  }

  for (const emplacement of EMPLACEMENTS_MODELE) {
    const path = `${emplacement.prefixe}${modele.fichier}`;
    const chemin = `${emplacement.dossier}/${modele.fichier}`;
    try {
      const info = await dep.stat({ path, directory: emplacement.directory });
      const octets = typeof info?.size === "number" ? info.size : null;
      emplacements.push({
        chemin,
        directory: emplacement.directory,
        path,
        octets,
        etat: octets === null ? "refuse" : "present",
        erreur: octets === null ? "stat a répondu sans taille" : null,
      });
    } catch (e) {
      const message = texteErreur(e);
      emplacements.push({
        chemin,
        directory: emplacement.directory,
        path,
        octets: null,
        etat: estAbsence(message) ? "absent" : "refuse",
        erreur: estAbsence(message) ? null : message,
      });
    }
  }

  return { emplacements, trouves: emplacements.filter((e) => e.etat === "present") };
}

/**
 * Dossier où Chrome dépose un téléchargement fait à la main : la mémoire interne
 * partagée (`/sdcard/Download`, soit `Environment.getExternalStorageDirectory()`
 * + « /Download »). C'est l'un des huit emplacements que le natif visite
 * (`getModelSearchPaths`, LlamaCpp.java:1116) — d'où la consigne affichée à
 * l'utilisateur : ce dossier, ce nom de fichier exact, et rien d'autre.
 */
export const DOSSIER_PUBLIC = "Download";

/**
 * Le chemin MANUEL, tel qu'on doit l'AFFICHER : de quoi débloquer l'utilisateur
 * sans dépendre d'une seule ligne de code de l'appli. Trois choses, et aucune
 * n'est facultative : le nom EXACT du fichier attendu (celui que le plugin
 * cherchera — `modeleGguf().fichier`), l'URL directe à ouvrir dans Chrome, et le
 * dossier où poser le fichier.
 */
export type CheminManuel = {
  /** Nom EXACT attendu par le plugin, ex. « Qwen2.5-Coder-0.5B-…-Q4_K_M.gguf ». */
  fichier: string;
  /** URL directe du GGUF : à ouvrir dans Chrome, sans passer par l'appli. */
  url: string;
  /** Dossier où poser le fichier. */
  dossier: string;
  /** Chemin complet lisible, ex. « /sdcard/Download/<fichier> ». */
  chemin: string;
  /** Taille exacte à obtenir, en octets (affichée en clair par l'appelant). */
  octets: number;
  /** Nom lisible du modèle, pour que l'utilisateur sache ce qu'il télécharge. */
  nom: string;
};

export function cheminManuel(id: LocalModelId): CheminManuel {
  const modele = modeleGguf(id);
  return {
    fichier: modele.fichier,
    url: modele.url,
    dossier: DOSSIER_PUBLIC,
    chemin: `/sdcard/${DOSSIER_PUBLIC}/${modele.fichier}`,
    octets: modele.octets,
    nom: modele.nom,
  };
}

/**
 * Message « le modèle n'est pas là » — autosuffisant, et VÉRIFIABLE par
 * l'utilisateur sans nous : le nom exact du fichier, l'URL à ouvrir dans Chrome,
 * et la consigne « le fichier doit se trouver dans le dossier Download ». C'est
 * la voie de secours quand le téléchargement de l'appli ne démarre pas : elle ne
 * dépend ni du réseau de l'appli, ni de `downloadFile`, ni de ce code.
 */
export function messageModeleIntrouvable(id: LocalModelId): string {
  const c = cheminManuel(id);
  return (
    `modèle introuvable sur le téléphone « ${c.nom} ». Télécharge ce fichier avec ` +
    `Chrome (${tailleLisible(c.octets)}) : ${c.url} — nom EXACT du fichier attendu : ` +
    `${c.fichier}. Le fichier doit se trouver dans le dossier Download, c'est-à-dire ` +
    `en ${c.chemin}. Ensuite, relance ta demande : rien d'autre à faire, le moteur ` +
    `trouve le fichier tout seul.`
  );
}

/**
 * RECONNAÎT NOS PROPRES MESSAGES. Ils sont déjà rédigés pour l'utilisateur ET
 * contiennent volontairement l'erreur brute (c'est le diagnostic) : les repasser
 * dans `messageErreurActionnable` les remplacerait par une phrase générique,
 * c'est-à-dire avalerait exactement ce qu'on cherche à montrer.
 */
export function estMessageLivraison(texte: string): boolean {
  return /modèle introuvable|livraison du modèle impossible/i.test(texte);
}

/**
 * Le message d'un ÉCHEC COMPLET : le chargement a échoué, le téléchargement de
 * secours aussi. On y met les DEUX erreurs RÉELLES, mot pour mot, plus le chemin
 * manuel — parce que c'est la seule façon de savoir pourquoi ça ne démarre pas,
 * et la seule issue praticable quand `downloadFile` est cassé sur l'appareil.
 */
export function messageLivraisonRatee(
  id: LocalModelId,
  erreurs: { erreurChargement?: string | null; erreurTelechargement?: string | null },
): string {
  const morceaux = [`livraison du modèle impossible « ${modeleGguf(id).nom} ».`];
  if (erreurs.erreurChargement) {
    morceaux.push(`Le chargement du modèle a échoué : ${erreurs.erreurChargement}.`);
  }
  if (erreurs.erreurTelechargement) {
    morceaux.push(`Le téléchargement de secours a échoué : ${erreurs.erreurTelechargement}.`);
  }
  morceaux.push(
    `Solution qui ne dépend pas de l'appli — ${messageModeleIntrouvable(id)}`,
  );
  return morceaux.join(" ");
}

/**
 * Ce que la livraison doit faire, injecté : les tests fournissent un chargeur et
 * un téléchargeur simulés, l'appli le moteur natif et `telechargerModele`.
 */
export type Livraison = {
  id: LocalModelId;
  /** Charge le modèle dans le moteur natif. Lève si le fichier est introuvable. */
  charger: (onProgres?: (p: ProgresChargement) => void) => Promise<void>;
  /** Télécharge le GGUF. Appelé UNIQUEMENT si `charger` a échoué. */
  telecharger: (onProgres?: (p: ProgresChargement) => void) => Promise<void>;
};

export type ResultatLivraison = {
  /** Vrai si le fichier était déjà là : le premier chargement a suffi. */
  dejaLa: boolean;
  /** Erreur RÉELLE du premier chargement (diagnostic), null si tout de suite OK. */
  erreurChargement: string | null;
  /** Erreur RÉELLE du téléchargement de secours, null si non tenté ou réussi. */
  erreurTelechargement: string | null;
};

/** Le texte d'une erreur, quelle que soit sa forme (Error, chaîne, objet). */
function texteErreur(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * L'ORDRE : charger d'abord, télécharger seulement si le chargement échoue.
 *
 * Pourquoi c'est le bon ordre, et pas juste une préférence : le plugin natif
 * trouve le GGUF tout seul s'il est dans Download (voir l'en-tête de ce fichier).
 * Télécharger d'abord faisait d'un `downloadFile` cassé — cas réel sur
 * l'appareil visé, où l'appel reste muet — un blocage total, même avec le bon
 * fichier déjà présent. Ici, AUCUNE requête réseau n'est faite si le modèle est
 * déjà là.
 *
 * Quand tout échoue, l'erreur levée contient les deux erreurs RÉELLES et le
 * chemin manuel (`messageLivraisonRatee`) : jamais un « échec » nu.
 */
export async function chargerPuisTelecharger(
  livraison: Livraison,
  onProgres?: (p: ProgresChargement) => void,
): Promise<ResultatLivraison> {
  // 1) CHARGER. Si le plugin trouve le fichier (Download, Documents, mémoire de
  //    l'appli…), c'est fini : zéro requête réseau, zéro écriture disque.
  await journaliser(`livraison : on CHARGE d'abord (« ${livraison.id} »), sans réseau`);
  try {
    await livraison.charger(onProgres);
    await journaliser("livraison : le chargement direct a suffi (aucun téléchargement)");
    return { dejaLa: true, erreurChargement: null, erreurTelechargement: null };
  } catch (e) {
    const erreurChargement = texteErreur(e);
    // Ce n'est PAS une erreur à afficher tout de suite : c'est le cas nominal du
    // premier lancement. On journalise pour le diagnostic, et on continue.
    console.warn("chargement direct du modèle impossible, on tente le secours :", erreurChargement);
    await journaliser(`chargement direct impossible : ${erreurChargement}`);

    // 2) TÉLÉCHARGER — confort, pas prérequis.
    await journaliser("livraison : on tente le téléchargement de secours (réseau)");
    try {
      await livraison.telecharger(onProgres);
      await journaliser("livraison : téléchargement de secours terminé");
    } catch (e2) {
      const erreurTelechargement = texteErreur(e2);
      await journaliser(`téléchargement de secours échoué : ${erreurTelechargement}`);
      throw new Error(
        messageLivraisonRatee(livraison.id, { erreurChargement, erreurTelechargement }),
      );
    }

    // 3) RECHARGER, une seule fois : le téléchargement a peut-être livré le
    //    fichier. S'il échoue encore, on ne le cache pas non plus.
    await journaliser("livraison : on RECHARGE après le téléchargement");
    try {
      await livraison.charger(onProgres);
    } catch (e3) {
      await journaliser(`rechargement après téléchargement échoué : ${texteErreur(e3)}`);
      throw new Error(
        messageLivraisonRatee(livraison.id, {
          erreurChargement: erreurChargement,
          erreurTelechargement: `le fichier a été téléchargé mais reste introuvable pour le moteur : ${texteErreur(e3)}`,
        }),
      );
    }
    return { dejaLa: false, erreurChargement, erreurTelechargement: null };
  }
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
export function tailleLisible(octets: number): string {
  if (octets >= 1e9) return `${(octets / 1e9).toFixed(2).replace(".", ",")} Go`;
  return `${Math.round(octets / 1e6)} Mo`;
}

/**
 * Le garde est-il dépassé ? PUR, donc testable sans horloge réelle.
 *
 * On compare le DERNIER OCTET NOUVEAU observé à l'instant présent : une
 * progression lente mais réelle ne déclenche jamais le garde, une absence
 * totale d'octets nouveaux pendant `delaiGardeMs` oui.
 */
export function gardeDepassee(
  dernierOctetNouveauMs: number,
  maintenantMs: number,
  delaiGardeMs: number = DELAI_GARDE_MS,
): boolean {
  return maintenantMs - dernierOctetNouveauMs >= delaiGardeMs;
}

/**
 * Le message que l'utilisateur doit lire NOIR SUR BLANC quand le
 * téléchargement ne bouge plus — jamais un écran mort. Il dit ce qui s'est
 * passé (octets reçus / attendus), quoi vérifier, et comment reprendre.
 */
export function messageGarde(
  secondesSansOctet: number,
  modele: ModeleGguf,
  octetsRecus: number,
): string {
  return (
    `le téléchargement ne progresse plus depuis ${secondesSansOctet} s ` +
    `(${tailleLisible(octetsRecus)} reçus sur ${tailleLisible(modele.octets)}). ` +
    `Vérifie la connexion Wi-Fi — ou passe à un autre réseau. Pour reprendre, ` +
    `relance ta demande depuis la conversation : le téléchargement repart de ` +
    `zéro (l'avancement d'un fichier partiel n'est pas réutilisable ici).`
  );
}

/**
 * Traduit l'échec brut du téléchargement en CAUSE identifiable. On branche sur
 * les messages réels d'Android/Java et du réseau, pas sur une supposition :
 *  - « No space left on device » / ENOSPC → espace de stockage ;
 *  - « Unable to resolve host », « UnknownHost », timeouts, « network » →
 *    connexion.
 */
export function causeEchec(brut: string): "espace" | "reseau" | "inconnu" {
  if (/no space left|ENOSPC|insufficient storage|not enough space/i.test(brut)) return "espace";
  if (/UnknownHost|Unable to resolve host|ConnectException|SocketTimeout|timed out|network|EHOSTUNREACH|ENETUNREACH|SSL/i.test(brut))
    return "reseau";
  return "inconnu";
}

/**
 * Message actionnable pour un échec de téléchargement, selon sa cause réelle.
 *
 * L'ERREUR BRUTE EST TOUJOURS CITÉE, entre parenthèses. C'est volontaire : sans
 * elle, un `downloadFile` qui ne démarre pas laisse un « échec » sans cause, et
 * on ne peut pas savoir ce qui s'est passé. `detail` ajoute ce que le plugin ne
 * dit pas : le temps écoulé et les octets réellement reçus. Zéro octet reçu,
 * c'est l'appel lui-même qui n'a pas démarré — on le DIT, au lieu de laisser
 * croire à un problème de réseau.
 */
export function messageEchec(
  modele: ModeleGguf,
  brut: string,
  detail?: { ecouleMs?: number; octetsRecus?: number },
): string {
  const commune = ` Relance le téléchargement : il repart de zéro.`;
  const diagnostic = diagnosticDemarrage(detail);
  switch (causeEchec(brut)) {
    case "espace":
      return (
        `le téléchargement de ${modele.nom} a échoué : il n'y a plus assez ` +
        `d'espace libre sur le téléphone pour ${tailleLisible(modele.octets)} ` +
        `(${brut}). Libère de la place, puis relance.` +
        diagnostic +
        commune
      );
    case "reseau":
      return (
        `le téléchargement de ${modele.nom} a échoué : la connexion n'a pas ` +
        `tenu (${brut}). Vérifie le Wi-Fi, puis relance.` +
        diagnostic +
        commune
      );
    default:
      return (
        `le téléchargement de ${modele.nom} a échoué (${brut}). Vérifie que le ` +
        `téléphone est connecté à Internet et qu'il reste au moins ` +
        `${tailleLisible(modele.octets)} d'espace libre, puis relance.` +
        diagnostic +
        commune
      );
  }
}

/**
 * Ce qui distingue un échec d'un NON-DÉMARRAGE. Un `downloadFile` qui rejette
 * sans avoir reçu le moindre octet n'a jamais commencé : ni le réseau, ni la
 * place ne sont en cause, c'est l'appel natif. Le dire évite de chercher au
 * mauvais endroit. Volontairement neutre en vocabulaire (« réseau », « espace »,
 * « Wi-Fi » n'y apparaissent pas) : les messages de cause ci-dessus portent déjà
 * ces mots, et les mélanger rendrait les deux diagnostics indiscernables.
 */
function diagnosticDemarrage(detail?: { ecouleMs?: number; octetsRecus?: number }): string {
  if (!detail || detail.octetsRecus === undefined || detail.octetsRecus > 0) return "";
  const ms = Math.max(0, Math.round(detail.ecouleMs ?? 0));
  return (
    ` Aucun octet n'a été reçu et l'appel a échoué en ${ms} ms : la panne est dans ` +
    `l'appel de téléchargement lui-même, pas dans la bande passante. Passe par le ` +
    `téléchargement manuel décrit ci-dessus.`
  );
}

/**
 * Le vrai plugin Capacitor, chargé à l'appel. `import()` dynamique : ce module
 * reste compilable et testable sans Capacitor, et le bundle navigateur ne tire
 * pas `@capacitor/filesystem`. Le contrat du plugin est plus large que
 * `PluginFichiers` ; on le restreint volontairement (même approche que pour le
 * plugin llama.cpp dans `moteurNatif.ts`).
 *
 * ON NE REND PAS L'OBJET DU PLUGIN TEL QUEL : le proxy de Capacitor expose un
 * `then` qui LÈVE sur la plateforme web (« "Filesystem.then()" is not
 * implemented on web »), et le simple fait de le faire passer dans une promesse
 * le déclenche — donc le seul fait de l'attendre, ici. Le rejet ainsi produit
 * échappait à l'appelant et remontait en « unhandled rejection ». On rend donc
 * un objet PLAT de fonctions : jamais un thenable.
 */
export async function pluginFichiersParDefaut(): Promise<PluginFichiers> {
  const { Filesystem } = await import("@capacitor/filesystem");
  const f = Filesystem as unknown as PluginFichiers;
  const adaptateur: PluginFichiers = {
    mkdir: (o) => f.mkdir(o),
    stat: (o) => f.stat(o),
    downloadFile: (o) => f.downloadFile(o),
    addListener: (e, cb) => f.addListener(e, cb),
  };
  // FACULTATIVE dans le contrat : on ne l'expose que si le plugin la fournit.
  const supprimer = f.deleteFile?.bind(f);
  if (supprimer) adaptateur.deleteFile = (o) => supprimer(o);
  return adaptateur;
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
  // Nos propres diagnostics (messageLivraisonRatee, messageModeleIntrouvable)
  // contiennent l'erreur brute EXPRÈS, et la phrase « Failed to initialize native
  // context » peut s'y trouver. Les retraduire effacerait l'URL, le nom de
  // fichier et l'erreur réelle : exactement ce qu'il ne faut plus avaler.
  if (estMessageLivraison(brut)) return brut;
  // Erreur brute du plugin llama.cpp quand le fichier du modèle n'est pas
  // trouvé/chargeable (LlamaCpp.java : « Failed to initialize native context »).
  // C'est précisément le symptôme d'une livraison ratée du modèle.
  if (/Failed to initialize native context|Model path is required|Model not found/i.test(brut)) {
    const prefixe = id
      ? `Le moteur natif n'a pas pu ouvrir le fichier du modèle « ${modeleGguf(id).nom} », ` +
        `qui est pourtant cherché sur le téléphone. `
      : `Le moteur natif n'a pas pu ouvrir le fichier du modèle. `;
    const suite = id
      ? messageModeleIntrouvable(id)
      : `Relance le téléchargement du modèle (connexion Internet requise), en vérifiant ` +
        `qu'il reste assez d'espace libre sur le téléphone.`;
    // On garde l'erreur brute à la fin : sans elle, impossible de savoir POURQUOI
    // le natif n'a pas ouvert le fichier.
    return `${prefixe}${suite} (erreur du moteur : ${brut})`;
  }
  return brut;
}

/**
 * Livre le GGUF sur l'appareil, à l'endroit que le plugin natif visite vraiment,
 * et VÉRIFIE le résultat. Renvoie le nom de fichier à passer comme `model`.
 *
 * SECOURS, PAS PRÉREQUIS : c'est `chargerPuisTelecharger` qui décide de
 * l'appeler, et elle ne le fait QUE si le chargement direct a échoué. L'appli
 * n'a donc pas besoin que cette fonction marche (c'est heureux : sur l'appareil
 * visé, `downloadFile` ne démarre pas) ; un GGUF posé à la main dans Download
 * suffit.
 *
 * - No-op si le fichier est déjà présent ET de taille plausible (pas de
 *   re-téléchargement de 400 Mo à chaque lancement) ;
 * - `onProgres` reçoit la phase « telechargement » avec un pourcentage RÉEL, les
 *   OCTETS reçus et le TOTAL — de quoi écrire à l'écran « téléchargement du
 *   modèle 42 % (430 Mo / 986 Mo) ». Le pourcentage est calculé ICI : l'évènement
 *   du plugin (`ProgressStatus`) ne contient que `url`, `bytes`, `contentLength`;
 * - la progression est MESURÉE DEUX FOIS : par l'évènement `progress` (octets
 *   reçus) et, chaque seconde, par la TAILLE DU FICHIER sur le disque (`stat`).
 *   L'interface avance donc même si l'évènement reste muet — c'est ce qui
 *   supprime l'écran figé que voyait l'utilisateur ;
 * - GARDE : si AUCUN octet nouveau n'apparaît pendant 60 s (les deux mesures
 *   réunies), on abandonne et l'erreur dit noir sur blanc « le téléchargement ne
 *   progresse plus depuis 60 s », avec quoi vérifier et comment reprendre ;
 * - un échec n'est JAMAIS avalé : téléchargement raté, fichier introuvable ou
 *   taille incohérente lèvent une erreur qui dit quoi faire, et le fichier
 *   partiel est effacé pour que la reprise reparte d'un état propre.
 *
 * REPRISE : `downloadFile` ouvre le fichier avec `FileOutputStream(file, false)`
 * (vérifié dans `LegacyFilesystemImplementation.kt`) — il TRONQUE. Un fichier
 * partiel n'est donc pas « repris », il est recommencé ; on ne fait pas semblant
 * du contraire, on efface le partiel et on le dit dans le message.
 *
 * @param plugin Injecté par les tests ; en production, le plugin Capacitor est
 *               chargé dynamiquement.
 * @param options Horloge/minuterie injectables (tests) et délai de garde.
 */
export async function telechargerModele(
  id: LocalModelId,
  onProgres?: (p: ProgresChargement) => void,
  plugin?: PluginFichiers,
  options: OptionsLivraison = {},
): Promise<string> {
  const modele: ModeleGguf = modeleGguf(id);
  const relatif = cheminRelatif(id);
  await journaliser(
    `téléchargement : cible ${relatif} (${modele.fichier}, ${modele.octets} octets attendus)`,
  );
  const dep = plugin ?? (await pluginFichiersParDefaut());
  const debut = Date.now();
  const maintenant = options.maintenant ?? (() => Date.now());
  const delaiGarde = options.delaiGardeMs ?? DELAI_GARDE_MS;
  const planifier =
    options.planifier ??
    ((cb: () => void, ms: number) => {
      const t = setInterval(cb, ms);
      return () => clearInterval(t);
    });

  /** Total annoncé : l'évènement peut le préciser, sinon on connaît la taille. */
  let totalAnnonce = modele.octets;
  let octetsRecus = 0;
  let dernierOctetAnnonce = 0;
  let derniereAvancee = maintenant();
  let arreter: () => void = () => {};
  let fini = false;
  let echecGarde: Error | null = null;

  const publier = (octets: number) => {
    if (!onProgres) return;
    const brut = totalAnnonce > 0 ? (octets / totalAnnonce) * 100 : 0;
    onProgres({
      phase: "telechargement",
      // 99 au maximum : les 100 % sont réservés à la fin RÉELLE (fichier vérifié).
      pct: Math.max(0, Math.min(99, Math.floor(brut))),
      fichier: modele.fichier,
      ecouleMs: maintenant() - debut,
      octetsRecus: octets,
      octetsTotal: totalAnnonce,
    });
  };

  /** Un octet NOUVEAU recule le garde ; un octet identique ou moindre ne fait rien. */
  const avancer = (octets: number) => {
    if (!Number.isFinite(octets) || octets <= dernierOctetAnnonce) return;
    dernierOctetAnnonce = octets;
    octetsRecus = octets;
    derniereAvancee = maintenant();
  };

  /* --------------------------------------------------------------------- */
  /* Surveillance périodique : octet courant + délai de garde. Rien ici ne   */
  /* dépend d'un évènement que le plugin pourrait ne jamais émettre.         */
  /* --------------------------------------------------------------------- */
  let rejeter: ((e: Error) => void) | null = null;
  const garde = new Promise<never>((_, rej) => {
    rejeter = rej;
  });
  // Si le téléchargement réussit avant le garde, ce rejet resterait sans preneur :
  // on l'apprivoise explicitement.
  garde.catch(() => {});

  async function surveiller(): Promise<void> {
    if (fini) return;
    // Taille réellement écrite sur le disque : la 2e source de vérité, celle
    // qui parle même quand l'évènement « progress » est muet.
    const taille = await taillePresente(dep, relatif);
    if (taille !== null) {
      avancer(taille);
      publier(octetsRecus);
    }
    const maintenantMs = maintenant();
    if (gardeDepassee(derniereAvancee, maintenantMs, delaiGarde)) {
      const secondes = Math.max(0, Math.round((maintenantMs - derniereAvancee) / 1000));
      echecGarde = new Error(messageGarde(secondes, modele, octetsRecus));
      fini = true;
      rejeter?.(echecGarde);
    }
  }

  // 1) DÉJÀ LÀ ? On ne relance pas un téléchargement de centaines de Mo pour
  //    rien. La taille doit être plausible : un fichier tronqué est traité comme
  //    absent et re-téléchargé.
  const present = await taillePresente(dep, relatif);
  if (present !== null && taillePlausible(present, modele.octets)) {
    noter(`téléchargement inutile : le fichier est déjà là (${present} octets)`);
    onProgres?.({
      phase: "pret",
      pct: 100,
      fichier: modele.fichier,
      ecouleMs: 0,
      octetsRecus: modele.octets,
      octetsTotal: modele.octets,
    });
    return cheminModele(id);
  }
  noter(
    present === null
      ? "le fichier n'est pas dans la mémoire de l'appli : téléchargement nécessaire"
      : `fichier présent mais de taille incohérente (${present} octets vus, ${modele.octets} attendus) : re-téléchargement`,
  );

  // 2) CRÉER LE DOSSIER. `getFileObject` du plugin ne crée pas les dossiers
  //    parents et `downloadFile` ignore `recursive` : sans ce mkdir, le
  //    téléchargement échoue. mkdir échoue si le dossier existe déjà — on
  //    l'ignore, la vérification finale tranchera. Le mkdir est fait AVANT le
  //    téléchargement, jamais après.
  try {
    await dep.mkdir({ path: SOUS_DOSSIER, directory: DOSSIER_DATA, recursive: true });
  } catch {
    /* dossier probablement déjà présent : sans conséquence, la suite vérifiera */
  }

  // 3) TÉLÉCHARGER, en remontant la progression RÉELLE. Les évènements
  //    « progress » sont globaux au plugin : on filtre sur l'URL de CE modèle.
  let retirer: (() => Promise<void>) | null = null;
  if (onProgres) {
    try {
      const handle = await dep.addListener("progress", (p) => {
        // Les évènements sont globaux au plugin : ceux d'un autre fichier (ou
        // d'un autre modèle) ne doivent pas fausser la barre.
        if (p?.url && p.url !== modele.url) return;
        if (typeof p?.contentLength === "number" && p.contentLength > 0) {
          totalAnnonce = p.contentLength;
        }
        const recus = typeof p?.bytes === "number" ? p.bytes : dernierOctetAnnonce;
        avancer(recus);
        publier(octetsRecus);
      });
      retirer = () => handle.remove();
    } catch (e) {
      // L'écoute est un CONFORT, pas une condition de la livraison : si elle
      // échoue, la surveillance du fichier prend le relais au lieu de faire
      // échouer un téléchargement de plusieurs centaines de Mo.
      console.warn("progression du téléchargement indisponible :", e);
    }
  }

  publier(0);
  // Instant du DÉMARRAGE de l'appel : sert à dire « échec en X ms » quand
  // `downloadFile` rejette tout de suite — c'est-à-dire quand il n'a jamais
  // démarré. Sans ce chiffre, on ne peut pas distinguer les deux.
  const debutAppel = maintenant();
  // LA LIGNE EST ÉCRITE AVANT L'APPEL : si `downloadFile` ne rend jamais la
  // main (c'est arrivé sur l'appareil visé), la trace montre que c'est LUI qui
  // est en cause — et non la suite du chargement.
  await journaliser("téléchargement : appel de `downloadFile` (le natif doit rendre la main)");
  arreter = planifier(() => {
    void surveiller();
  }, 1000);

  const telechargement = dep.downloadFile({
    url: modele.url,
    path: relatif,
    directory: DOSSIER_DATA,
    // `progress: true` déclenche les évènements « progress » écoutés ci-dessus.
    progress: Boolean(onProgres),
    recursive: true,
    // SANS CES DEUX DÉLAIS, un téléchargement calé ne rend jamais la main
    // (HttpURLConnection attend indéfiniment) : voir `DELAIS_HTTP`.
    connectTimeout: DELAIS_HTTP.CONNEXION_MS,
    readTimeout: DELAIS_HTTP.LECTURE_MS,
  });
  // Si le délai de garde gagne la course, ce rejet arriverait SANS preneur (et la
  // WebView le signalerait en « unhandled rejection ») : on l'apprivoise, comme
  // `garde` plus haut. Le `Promise.race` ci-dessous continue de voir l'original.
  telechargement.catch(() => {});

  /** Réponse BRUTE du plugin, gardée pour le diagnostic si le fichier manque. */
  let reponse: { path?: string } | null = null;
  try {
    reponse = await Promise.race([telechargement, garde]);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await effacer(dep, relatif);
    // L'ERREUR BRUTE EST TOUJOURS MONTRÉE (dans le message), et journalisée :
    // c'est la seule façon de savoir pourquoi un téléchargement ne démarre pas.
    console.warn("téléchargement du modèle échoué :", detail);
    noter(
      `téléchargement ÉCHOUÉ en ${maintenant() - debutAppel} ms ` +
        `(${octetsRecus} octets reçus) : ${detail}`,
    );
    // Le garde a DÉJÀ rédigé son message (il nomme les secondes et les octets) ;
    // sinon on cite l'erreur réelle, le temps écoulé et les octets reçus.
    throw (
      echecGarde ??
      new Error(
        messageEchec(modele, detail, {
          ecouleMs: maintenant() - debutAppel,
          octetsRecus,
        }),
      )
    );
  } finally {
    fini = true;
    arreter();
    if (retirer) await retirer().catch(() => {});
  }

  // 4) VÉRIFIER. Un téléchargement peut « réussir » en laissant un fichier
  //    tronqué : on refuse alors de faire croire que le modèle est prêt, et on
  //    efface le raté pour que la reprise reparte d'un état propre.
  const apres = await taillePresente(dep, relatif);
  if (apres === null) {
    await effacer(dep, relatif);
    // Un `downloadFile` qui RÉUSSIT sur un fichier absent est un échec silencieux :
    // on montre ce que le plugin a répondu et où on a cherché, sinon il ne reste
    // rien à diagnostiquer.
    const reponseTexte = JSON.stringify(reponse ?? {});
    console.warn("téléchargement « réussi » mais fichier absent :", {
      cheminCherche: relatif,
      reponseDuPlugin: reponseTexte,
    });
    throw new Error(
      `le fichier du modèle est introuvable après le téléchargement. ` +
        `Le plugin a répondu ${reponseTexte} pour « ${relatif} » ` +
        `(mémoire de l'appli, dossier Documents). Vérifie que le téléphone a de ` +
        `l'espace de stockage libre, puis relance — ou télécharge le fichier à la ` +
        `main : ${cheminManuel(id).url}`,
    );
  }
  if (!taillePlausible(apres, modele.octets)) {
    await effacer(dep, relatif);
    throw new Error(
      `le fichier téléchargé fait ${tailleLisible(apres)} alors qu'il devrait faire ` +
        `${tailleLisible(modele.octets)} : le téléchargement est incomplet ou le fichier ` +
        `est corrompu. Relance le téléchargement (Wi-Fi conseillé, ${tailleLisible(modele.octets)}).`,
    );
  }

  onProgres?.({
    phase: "pret",
    pct: 100,
    fichier: modele.fichier,
    ecouleMs: maintenant() - debut,
    octetsRecus: apres,
    octetsTotal: modele.octets,
  });
  return cheminModele(id);
}

/**
 * Efface un fichier partiel/raté. JAMAIS fatal : sur Android, l'effacement peut
 * échouer tant que le flux natif tient le fichier ouvert — ce n'est pas une
 * raison de masquer l'erreur d'origine, qui est ce que l'utilisateur doit lire.
 */
async function effacer(dep: PluginFichiers, chemin: string): Promise<void> {
  try {
    await dep.deleteFile?.({ path: chemin, directory: DOSSIER_DATA });
  } catch {
    /* sans conséquence : la vérification de taille refusera le fichier de toute façon */
  }
}
