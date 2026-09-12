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

/** Message actionnable pour un échec de téléchargement, selon sa cause réelle. */
export function messageEchec(modele: ModeleGguf, brut: string): string {
  const commune = ` Relance le téléchargement : il repart de zéro.`;
  switch (causeEchec(brut)) {
    case "espace":
      return (
        `le téléchargement de ${modele.nom} a échoué : il n'y a plus assez ` +
        `d'espace libre sur le téléphone pour ${tailleLisible(modele.octets)} ` +
        `(${brut}). Libère de la place, puis relance.` +
        commune
      );
    case "reseau":
      return (
        `le téléchargement de ${modele.nom} a échoué : la connexion n'a pas ` +
        `tenu (${brut}). Vérifie le Wi-Fi, puis relance.` +
        commune
      );
    default:
      return (
        `le téléchargement de ${modele.nom} a échoué (${brut}). Vérifie que le ` +
        `téléphone est connecté à Internet et qu'il reste au moins ` +
        `${tailleLisible(modele.octets)} d'espace libre, puis relance.` +
        commune
      );
  }
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
  arreter = planifier(() => {
    void surveiller();
  }, 1000);

  try {
    await Promise.race([
      dep.downloadFile({
        url: modele.url,
        path: relatif,
        directory: DOSSIER_DATA,
        // `progress: true` déclenche les évènements « progress » écoutés ci-dessus.
        progress: Boolean(onProgres),
        recursive: true,
      }),
      garde,
    ]);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await effacer(dep, relatif);
    // Le garde a DÉJÀ rédigé son message (il nomme les secondes et les octets).
    throw echecGarde ?? new Error(messageEchec(modele, detail));
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
    throw new Error(
      `le fichier du modèle est introuvable après le téléchargement. ` +
        `Vérifie que le téléphone a de l'espace de stockage libre, puis relance.`,
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
