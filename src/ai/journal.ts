/**
 * TRACE DE DÉMARRAGE — un fichier LISIBLE DEPUIS LE TÉLÉPHONE.
 *
 * POURQUOI CE FICHIER EXISTE, plutôt qu'un `console.log` : l'utilisateur n'a
 * QUE son téléphone. `adb logcat` suppose un ordinateur, un câble et le SDK ;
 * il ne peut donc pas lire ce que la console de la WebView raconte. Ce module
 * écrit la MÊME chose dans un fichier texte, à un endroit qu'un simple
 * gestionnaire de fichiers sait ouvrir.
 *
 * CE QU'IL APPORTE, ET QUI EST LE POINT DE TOUT ÇA : chaque étape est écrite
 * AVANT d'être exécutée (jamais après). Si le chargement se bloque, la DERNIÈRE
 * LIGNE du fichier nomme l'étape où l'application s'est arrêtée. Un journal
 * écrit après coup aurait le défaut fatal d'être muet au moment précis où on a
 * besoin de lui — un blocage n'exécute pas la ligne suivante.
 *
 * OÙ LE FICHIER EST ÉCRIT, et pourquoi ces emplacements-là (chaque affirmation
 * est vérifiée, pas supposée) :
 *
 *  1. `/sdcard/Download/journal-studio.txt` — le chemin demandé. `Directory
 *     EXTERNAL_STORAGE` de @capacitor/filesystem 8.1.3 est le seul qui donne
 *     racine du stockage partagé (`getDirectory()` : `Environment
 *     getExternalStorageDirectory()`, LegacyFilesystemImplementation.kt:50-60)
 *     et il n'existe AUCUN `Directory` pour le dossier Download lui-même. La
 *     création d'un fichier NON-MÉDIA (un .txt) DANS Download est autorisée
 *     sans permission : c'est le comportement « contribute my own file »
 *     d'Android 11+, tenu par les tests de conformité d'Android
 *     (`assertCanCreateFile(new File(downloadDir, NONMEDIA_FILE_NAME))`,
 *     ScopedStorageDeviceTest.java). Seule la RACINE du stockage partagé est
 *     interdite (`Operation not permitted` sur `getExternalStorageDir()`), et
 *     on ne l'écrit pas.
 *  2. `/sdcard/Documents/journal-studio.txt` — `Directory.DOCUMENTS`
 *     (`Environment.getExternalStoragePublicDirectory(DIRECTORY_DOCUMENTS)`),
 *     également autorisé en écriture pour un fichier non-média
 *     (`assertCanCreateFile(new File(documentsDir, NONMEDIA_FILE_NAME))`).
 *  3. `/sdcard/Documents/Studio/journal-studio.txt` — même dossier, mais dans
 *     un sous-dossier : le chemin imbriqué contourne le contrôle de permission
 *     « stockage public » du plugin quand il existe, sur Android 11 et 12, où
 *     `isStoragePermissionGranted` ne répond `true` d'office qu'à partir d'API
 *     33 (`FilesystemPlugin.kt`). Sur les API 30-32, un chemin SANS dossier
 *     parent (`uri.parentFolder == null`) fait exiger `MANAGE_EXTERNAL_STORAGE`
 *     — une permission que l'appli ne déclare PAS et ne demande pas.
 *  4. `/sdcard/Android/data/<paquet>/files/journal-studio.txt` —
 *     `Directory.EXTERNAL`, toujours écrivable, mais PLUS lisible par un
 *     gestionnaire de fichiers depuis Android 11. Repli, pas un objectif.
 *  5. mémoire privée de l'appli — `Directory.DATA`, le dernier recours : le
 *     fichier existe alors pour un futur `adb pull`, et pas pour l'utilisateur.
 *
 * LE REFUS DE PERMISSION NE DOIT JAMAIS FAIRE ÉCHOUER LE CHARGEMENT. Toutes
 * les écritures sont donc encapsulées : délai maximal (`DELAI_ECRITURE_MS`),
 * erreurs comptées, abandon définitif après `MAX_ECHECS_SUIVIS` échecs, et
 * JAMAIS d'exception qui remonte à l'appelant. Un journal indisponible est un
 * problème de journal — pas une raison d'empêcher le modèle de tourner.
 *
 * `etatJournal()` rend le résultat de cette recherche : emplacement retenu,
 * type d'emplacement, erreurs réellement renvoyées par le plugin, et la liste
 * des emplacements refusés. L'appelant peut ainsi DIRE À L'UTILISATEUR où est
 * la trace — ou prévenir qu'elle n'a pas pu être écrite.
 *
 * Le plugin n'est pas importé au chargement du module : `import()` dynamique à
 * l'appel, donc le bundle navigateur ne tire pas `@capacitor/filesystem` et les
 * tests Node tournent sans Capacitor.
 */

/** Version de l'application reportée en tête de trace. */
export const VERSION_APP = "1.0";

/**
 * Version du FORMAT de la trace. À incrémenter quand les lignes changent :
 * deux traces qui ne se lisent pas pareil ne doivent pas porter le même
 * numéro, sinon on croit lire la même chose.
 */
export const FORMAT_TRACE = 2;

/** Nom du fichier, à la racine de l'emplacement retenu. */
export const NOM_JOURNAL = "journal-studio.txt";

/**
 * Taille au-delà de laquelle la trace est REPARTIE DE ZÉRO au démarrage suivant
 * (262 144 = 256 Ko, très au-dessus d'une session de diagnostic normale). Sans
 * cette borne, un fichier jamais purgé finirait par peser des dizaines de Mo et
 * par coûter plus cher à lire qu'à écrire. On EFFACE au lieu de tronquer au
 * milieu : mieux vaut perdre d'anciennes sessions que lire une ligne coupée.
 */
export const TAILLE_MAX_JOURNAL = 262_144;

/** `utf8` : la valeur littérale de `Encoding.UTF8` du plugin (pas d'import ici). */
const ENCODAGE = "utf8";

/**
 * Délai maximal accordé à UNE écriture. Une écriture native qui ne rend pas la
 * main ne doit pas retenir le chargement : au-delà de ce délai, on considère
 * l'écriture perdue et on continue le chargement. 1,5 s est large pour une
 * écriture locale de quelques dizaines d'octets.
 */
export const DELAI_ECRITURE_MS = 1_500;

/** Après ce nombre d'échecs CONSÉCUTIFS, on arrête d'essayer jusqu'au prochain démarrage. */
export const MAX_ECHECS_SUIVIS = 3;

/**
 * Délai TOTAL accordé à la recherche d'un emplacement au DÉMARRAGE (5 s).
 *
 * POURQUOI CE PLAFOND EXISTE : chaque appel a droit à `DELAI_ECRITURE_MS`, mais
 * la recherche en fait plusieurs par emplacement (mkdir, stat, writeFile) sur
 * jusqu'à cinq emplacements. Un plugin qui ne répondrait à RIEN ferait donc
 * payer 5 × 3 × 1,5 s ≈ 22 s — et la PREMIÈRE ligne de trace est attendue par le
 * chargement (voir `journaliser`, qui attend la fin du démarrage pour ne perdre
 * aucune ligne). Le diagnostic deviendrait alors exactement la panne qu'il est
 * censé décrire. Au-delà de ce plafond, on déclare la trace indisponible, on le
 * dit, et la vie continue.
 */
export const DELAI_DEMARRAGE_MS = 5_000;

/** Emplacements du plugin @capacitor/filesystem 8.1.3 réellement reconnus. */
export type EmplacementJournal = "EXTERNAL_STORAGE" | "DOCUMENTS" | "EXTERNAL" | "DATA";

/** Un emplacement candidat, essayé dans l'ordre du tableau. */
export type CandidatJournal = {
  /** Valeur du `Directory` du plugin (chaîne littérale, jamais un import). */
  directory: EmplacementJournal;
  /** Chemin passé au plugin, relatif à `directory`. */
  path: string;
  /** Le même chemin tel qu'on l'écrirait à la main sur le téléphone. */
  cheminLisible: string;
  /**
   * Ouvrable par un gestionnaire de fichiers ? Vrai seulement pour le stockage
   * partagé. Sert à prévenir l'utilisateur quand la trace a dû se replier sur
   * un endroit qu'il ne peut PAS ouvrir lui-même.
   */
  visible: boolean;
  /** Sous-dossier à créer avant d'écrire (`mkdir`), si l'emplacement en exige un. */
  dossierACreer?: string;
};

/**
 * LES EMPLACEMENTS, DANS L'ORDRE. Le premier qui accepte une écriture gagne —
 * on le vérifie en écrivant vraiment l'en-tête, pas en supposant d'après l'API
 * level : c'est la seule preuve qui vaille, l'appareil et l'OEM tranchent.
 */
export const CANDIDATS_JOURNAL: readonly CandidatJournal[] = [
  {
    directory: "EXTERNAL_STORAGE",
    // PAS de sous-dossier à créer : Download existe sur tout appareil Android.
    path: `Download/${NOM_JOURNAL}`,
    cheminLisible: `/sdcard/Download/${NOM_JOURNAL}`,
    visible: true,
  },
  {
    directory: "DOCUMENTS",
    path: NOM_JOURNAL,
    cheminLisible: `/sdcard/Documents/${NOM_JOURNAL}`,
    visible: true,
  },
  {
    directory: "DOCUMENTS",
    path: `Studio/${NOM_JOURNAL}`,
    cheminLisible: `/sdcard/Documents/Studio/${NOM_JOURNAL}`,
    visible: true,
    dossierACreer: "Studio",
  },
  {
    directory: "EXTERNAL",
    path: NOM_JOURNAL,
    cheminLisible: `/sdcard/Android/data/<paquet>/files/${NOM_JOURNAL}`,
    visible: false,
  },
  {
    directory: "DATA",
    path: NOM_JOURNAL,
    cheminLisible: `mémoire privée de l'appli (getFilesDir())/${NOM_JOURNAL}`,
    visible: false,
  },
];

/**
 * Ce qu'on attend du plugin @capacitor/filesystem, réduit aux opérations
 * utilisées ici — donc simulable, et sans dépendre de ses types.
 */
export type PluginJournal = {
  writeFile: (o: {
    path: string;
    data: string;
    directory: string;
    encoding?: string;
    recursive?: boolean;
  }) => Promise<unknown>;
  appendFile: (o: { path: string; data: string; directory: string; encoding?: string }) => Promise<unknown>;
  mkdir: (o: { path: string; directory: string; recursive?: boolean }) => Promise<unknown>;
  stat: (o: { path: string; directory: string }) => Promise<{ size: number }>;
  deleteFile?: (o: { path: string; directory: string }) => Promise<void>;
  getUri?: (o: { path: string; directory: string }) => Promise<{ uri: string }>;
};

/** Ce que l'appelant peut savoir de la trace, à tout moment. */
export type EtatJournal = {
  /** Vrai si les écritures sont possibles (un emplacement a accepté l'en-tête). */
  actif: boolean;
  /** Emplacement retenu, tel qu'on l'annonce à l'utilisateur ; `null` si aucun. */
  chemin: string | null;
  /** Vrai si l'utilisateur peut ouvrir ce chemin avec un gestionnaire de fichiers. */
  visible: boolean;
  /** Chemin ABSOLU rendu par le plugin (`file://…`), quand il sait le donner. */
  cheminReel: string | null;
  /** Emplacements refusés, avec l'erreur BRUTE qu'ils ont rendue. */
  refus: { chemin: string; erreur: string }[];
  /** Erreurs d'écriture survenues APRÈS le choix de l'emplacement. */
  erreurs: string[];
};

export type OptionsJournal = {
  /** Plugin injecté (tests). Par défaut : le plugin Capacitor, importé à l'appel. */
  plugin?: PluginJournal;
  /** Horloge injectable (tests). */
  maintenant?: () => Date;
  /** Emplacements à essayer, dans l'ordre (tests : un seul candidat). */
  candidats?: readonly CandidatJournal[];
  /** Délai maximal par écriture. */
  delaiMs?: number;
  /** Délai maximal pour TOUTE la recherche d'emplacement (défaut : 5 s). */
  delaiTotalMs?: number;
};

const ETAT_VIDE: EtatJournal = {
  actif: false,
  chemin: null,
  visible: false,
  cheminReel: null,
  refus: [],
  erreurs: [],
};

/** État courant — remplacé, jamais muté en place, pour que les lecteurs soient sûrs. */
let etat: EtatJournal = ETAT_VIDE;
/** La promesse de démarrage : `journaliser` l'attend, pour ne perdre aucune ligne. */
let demarrageEnCours: Promise<EtatJournal> | null = null;
/** Emplacement retenu (et sa forme brute pour les appels suivants). */
let retenu: CandidatJournal | null = null;
/** Plugin retenu au démarrage. */
let pluginRetenu: PluginJournal | null = null;
let maintenant: () => Date = () => new Date();
let delaiMs = DELAI_ECRITURE_MS;
let echecsSuivis = 0;
/** Sérialise les écritures : deux lignes ne peuvent pas s'entrelacer. */
let fileEcritures: Promise<void> = Promise.resolve();

/** Le texte d'une erreur, quelle que soit sa forme. */
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
 * Horodatage LOCAL, à la seconde et au millième : « 2026-09-12 18:20:31.123 ».
 * Local et pas UTC, parce que la trace sera comparée à ce que l'utilisateur a
 * vu à l'écran : « il est 18 h 20 quand ça a bloqué ».
 */
export function horodatage(date: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  return (
    `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} ` +
    `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}.${p3(date.getMilliseconds())}`
  );
}

/** Une ligne du fichier, horodatée. PURE : c'est elle que les tests vérifient. */
export function ligneJournal(texte: string, date: Date): string {
  return `[${horodatage(date)}] ${texte}\n`;
}

/** Enveloppe une promesse d'un délai maximal : au-delà, elle est déclarée perdue. */
async function avecDelai<T>(p: Promise<T>, ms: number, quoi: string): Promise<T> {
  // Le budget peut tomber à zéro (ou passer négatif) après une série d'appels
  // lents : on garde un seuil minimal pour que le message reste lisible et que le
  // minuteur ait toujours un sens.
  const limite = Math.max(1, Math.round(ms));
  let minuteur: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rejeter) => {
        minuteur = setTimeout(() => rejeter(new Error(`${quoi} : aucun retour en ${limite} ms`)), limite);
      }),
    ]);
  } finally {
    if (minuteur !== null) clearTimeout(minuteur);
  }
}

/**
 * Le plugin Capacitor, chargé À L'APPEL. `import()` dynamique : ce module reste
 * compilable et testable sans Capacitor, et le bundle navigateur ne tire pas
 * `@capacitor/filesystem`.
 *
 * ON NE REND PAS L'OBJET DU PLUGIN TEL QUEL, et c'est un piège réel, pas une
 * préférence : le proxy de Capacitor expose un `then` qui LÈVE sur la plateforme
 * web (`"Filesystem.then()" is not implemented on web`), et le simple fait de
 * faire passer ce proxy dans une promesse le déclenche — donc le seul fait de
 * l'attendre. On rend un objet PLAT de fonctions : jamais un thenable, jamais de
 * rejet qui échappe à l'appelant.
 */
async function pluginJournalParDefaut(): Promise<PluginJournal> {
  const { Filesystem } = await import("@capacitor/filesystem");
  const f = Filesystem as unknown as PluginJournal;
  const adaptateur: PluginJournal = {
    writeFile: (o) => f.writeFile(o),
    appendFile: (o) => f.appendFile(o),
    mkdir: (o) => f.mkdir(o),
    stat: (o) => f.stat(o),
  };
  // Les deux dernières sont FACULTATIVES dans le contrat : on ne les expose que
  // si le plugin les fournit vraiment, pour que l'appelant puisse les tester
  // (`if (plugin.deleteFile)`) au lieu de découvrir leur absence en les appelant.
  const supprimer = f.deleteFile?.bind(f);
  if (supprimer) adaptateur.deleteFile = (o) => supprimer(o);
  const uri = f.getUri?.bind(f);
  if (uri) adaptateur.getUri = (o) => uri(o);
  return adaptateur;
}

/** Le début de l'en-tête de trace, écrit AVANT toute autre étape. */
function enTete(date: Date, destination: string): string {
  const lignes = [
    "═══════════════════════════════════════════════════════════════════════",
    ` STUDIO LOCAL — trace de démarrage (format ${FORMAT_TRACE})`,
    ` application : version ${VERSION_APP} · paquet org.silexperience.studiolocal`,
    ` session     : ${horodatage(date)}`,
    ` fichier     : ${destination}`,
    " Chaque ligne est écrite AVANT l'étape qu'elle annonce : si le fichier",
    " s'arrête, la dernière ligne nomme l'étape où l'application s'est bloquée.",
    "═══════════════════════════════════════════════════════════════════════",
    `[${horodatage(date)}] démarrage de l'application (version ${VERSION_APP})`,
  ];
  return lignes.map((l) => `${l}\n`).join("");
}

/**
 * Cherche un emplacement qui ACCEPTE une écriture, en écrivant réellement
 * l'en-tête dedans, puis retient le premier qui répond. Ne lève jamais.
 */
async function choisirEmplacement(
  plugin: PluginJournal,
  candidats: readonly CandidatJournal[],
  options: { delaiMs: number; maintenant: () => Date; delaiTotalMs: number },
): Promise<void> {
  const refus: { chemin: string; erreur: string }[] = [];
  const date = options.maintenant();
  const debut = Date.now();
  /**
   * Le budget restant, PLAFONNÉ par le délai par appel : c'est ce qui empêche
   * l'ensemble de la recherche de durer plus longtemps que `delaiTotalMs`, quel
   * que soit le nombre d'emplacements. 0 (ou moins) veut dire « on arrête ».
   */
  const budget = () => Math.min(options.delaiMs, options.delaiTotalMs - (Date.now() - debut));

  for (const candidat of candidats) {
    if (budget() <= 0) {
      refus.push({
        chemin: candidat.cheminLisible,
        erreur: `délai total de recherche dépassé (${options.delaiTotalMs} ms) : emplacement non essayé`,
      });
      continue;
    }
    const enTeteTexte = enTete(date, candidat.cheminLisible);
    try {
      // 1) Sous-dossier éventuel. Il peut déjà exister : l'échec du mkdir n'est
      //    PAS un échec de l'emplacement — c'est l'écriture qui tranchera.
      if (candidat.dossierACreer) {
        try {
          await avecDelai(
            plugin.mkdir({ path: candidat.dossierACreer, directory: candidat.directory, recursive: true }),
            budget(),
            "mkdir",
          );
        } catch {
          /* dossier probablement déjà présent : sans conséquence */
        }
      }

      // 2) Purge si la trace est devenue énorme. On efface, on ne tronque pas au
      //    milieu : une ligne coupée en deux serait pire qu'une session perdue.
      const taille = await tailleFichier(plugin, candidat, budget());
      if (taille !== null && taille > TAILLE_MAX_JOURNAL && plugin.deleteFile) {
        await avecDelai(
          plugin.deleteFile({ path: candidat.path, directory: candidat.directory }),
          budget(),
          "deleteFile",
        );
      }

      // 3) L'écriture qui PROUVE l'emplacement : l'en-tête. `recursive` au cas où
      //    le dossier parent n'existerait pas encore.
      await avecDelai(
        plugin.writeFile({
          path: candidat.path,
          data: enTeteTexte,
          directory: candidat.directory,
          encoding: ENCODAGE,
          recursive: true,
        }),
        budget(),
        "writeFile",
      );

      retenu = candidat;
      pluginRetenu = plugin;
      const cheminReel = await cheminAbsolu(plugin, candidat, budget());
      etat = {
        actif: true,
        chemin: candidat.cheminLisible,
        visible: candidat.visible,
        cheminReel,
        refus,
        erreurs: [],
      };
      return;
    } catch (e) {
      // On garde l'erreur BRUTE : « EACCES » et « Operation not permitted » ne
      // veulent pas dire la même chose, et c'est tout ce qu'on aura à lire.
      refus.push({ chemin: candidat.cheminLisible, erreur: texteErreur(e) });
    }
  }

  etat = { ...ETAT_VIDE, refus };
}

/** Taille du fichier, `null` s'il n'existe pas (stat qui rejette = absent, pas une erreur). */
async function tailleFichier(
  plugin: PluginJournal,
  candidat: CandidatJournal,
  delaiMs: number,
): Promise<number | null> {
  try {
    const info = await avecDelai(
      plugin.stat({ path: candidat.path, directory: candidat.directory }),
      delaiMs,
      "stat",
    );
    return typeof info?.size === "number" ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Chemin ABSOLU réel, quand le plugin sait le donner (`getUri`). C'est ce qui
 * transforme « peut-être /sdcard/Download » en un chemin qu'on peut copier dans
 * une réponse. Best-effort assumé : `null` si le plugin ne répond pas.
 */
async function cheminAbsolu(
  plugin: PluginJournal,
  candidat: CandidatJournal,
  delaiMs: number,
): Promise<string | null> {
  if (typeof plugin.getUri !== "function") return null;
  try {
    const r = await avecDelai(
      plugin.getUri({ path: candidat.path, directory: candidat.directory }),
      delaiMs,
      "getUri",
    );
    return typeof r?.uri === "string" ? r.uri : null;
  } catch {
    return null;
  }
}

/**
 * DÉMARRE la trace : choisit l'emplacement, écrit l'en-tête (qui porte la ligne
 * « démarrage de l'application » — donc la preuve que l'écriture fonctionne
 * AVANT qu'on ajoute quoi que ce soit d'autre au journal) et retient le plugin.
 * Idempotent : un second appel rend le MÊME résultat, sans rien relancer.
 */
export function demarrerJournal(options: OptionsJournal = {}): Promise<EtatJournal> {
  if (demarrageEnCours === null) demarrageEnCours = demarrer(options);
  return demarrageEnCours;
}

async function demarrer(options: OptionsJournal): Promise<EtatJournal> {
  maintenant = options.maintenant ?? (() => new Date());
  delaiMs = options.delaiMs ?? DELAI_ECRITURE_MS;
  const delaiTotalMs = options.delaiTotalMs ?? DELAI_DEMARRAGE_MS;
  echecsSuivis = 0;

  let plugin = options.plugin ?? null;
  const candidats = options.candidats ?? CANDIDATS_JOURNAL;

  try {
    plugin = plugin ?? (await pluginJournalParDefaut());
  } catch (e) {
    // Pas de plugin du tout (navigateur, tests Node sans injection) : on le DIT
    // au lieu de faire semblant d'écrire.
    etat = {
      ...ETAT_VIDE,
      refus: candidats.map((c) => ({
        chemin: c.cheminLisible,
        erreur: `plugin fichiers indisponible : ${texteErreur(e)}`,
      })),
    };
    console.warn("[journal] écriture impossible : plugin fichiers indisponible", texteErreur(e));
    return etat;
  }

  await choisirEmplacement(plugin, candidats, { delaiMs, maintenant, delaiTotalMs });
  if (!etat.actif) {
    console.warn(
      "[journal] AUCUN emplacement n'a accepté l'écriture. Refus :",
      JSON.stringify(etat.refus),
    );
  }
  return etat;
}

/** État courant de la trace (lecture seule). */
export function etatJournal(): EtatJournal {
  return etat;
}

/**
 * Une ligne horodatée, écrite MAINTENANT. À appeler AVANT l'étape annoncée, et
 * à ATTENDRE pour les étapes critiques : c'est ce qui garantit que la ligne est
 * sur le disque même si l'étape suivante ne rend jamais la main.
 * Ne lève jamais, ne bloque jamais plus de `delaiMs`.
 */
export async function journaliser(texte: string): Promise<void> {
  const ligne = ligneJournal(texte, maintenant());
  // La console reste utile (et gratuite) : elle ne s'affiche pas sur le
  // téléphone, mais elle est là si quelqu'un branche un câble un jour.
  console.log(`[studio] ${texte}`);

  // Si le démarrage de la trace est EN COURS, on l'attend : une ligne écrite
  // pendant le démarrage (juste après le lancement de l'appli) ne doit pas être
  // perdue pour une histoire d'ordre. Aucune réentrance possible :
  // `demarrerJournal` n'appelle jamais `journaliser` (l'en-tête porte la ligne
  // de démarrage).
  if (demarrageEnCours !== null) {
    try {
      await demarrageEnCours;
    } catch {
      /* le démarrage ne lève jamais : rien à faire d'autre */
    }
  }

  const fichierActif = retenu;
  const plugin = pluginRetenu;
  if (!etat.actif || fichierActif === null || plugin === null) return;
  if (echecsSuivis >= MAX_ECHECS_SUIVIS) return;

  const ecrire = async () => {
    try {
      await avecDelai(
        plugin.appendFile({
          path: fichierActif.path,
          data: ligne,
          directory: fichierActif.directory,
          encoding: ENCODAGE,
        }),
        delaiMs,
        "appendFile",
      );
      echecsSuivis = 0;
    } catch (e) {
      echecsSuivis += 1;
      const detail = texteErreur(e);
      etat = { ...etat, erreurs: [...etat.erreurs, detail] };
      console.warn("[journal] écriture de ligne impossible :", detail);
      // Trop d'échecs d'affilée : on arrête d'essayer. Le chargement continue.
      if (echecsSuivis >= MAX_ECHECS_SUIVIS) etat = { ...etat, actif: false };
    }
  };

  fileEcritures = fileEcritures.then(ecrire, ecrire);
  await fileEcritures;
}

/**
 * Version NON attendue : la ligne est mise dans la file d'écriture (donc
 * sérialisée et ordonnée) et l'appelant continue tout de suite. À utiliser pour
 * les étapes où attendre l'écriture n'apporte rien — jamais pour l'étape dont
 * on cherche à savoir si elle se termine.
 */
export function noter(texte: string): void {
  void journaliser(texte);
}

/**
 * Attrape une erreur comme on l'écrirait dans le journal : texte INTÉGRAL,
 * jamais tronqué (une erreur rognée est une erreur perdue), plus la pile quand
 * elle existe. Sert à ne rien laisser passer d'un échec.
 */
export function texteErreurComplete(e: unknown): string {
  if (e instanceof Error) {
    const pile = e.stack ? `\n    ${e.stack.split("\n").slice(1, 4).join("\n    ")}` : "";
    return `${e.name}: ${e.message}${pile}`;
  }
  return texteErreur(e);
}

/** Remet le module à zéro (tests uniquement : aucun autre appelant ne l'utilise). */
export function reinitialiserJournal(): void {
  etat = ETAT_VIDE;
  demarrageEnCours = null;
  retenu = null;
  pluginRetenu = null;
  maintenant = () => new Date();
  delaiMs = DELAI_ECRITURE_MS;
  echecsSuivis = 0;
  fileEcritures = Promise.resolve();
}
