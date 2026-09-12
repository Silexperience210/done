/**
 * FAIRE TOURNER DU PYTHON DANS L'APPLI — pour de vrai, hors ligne.
 *
 * POURQUOI CE MODULE EXISTE : le propriétaire l'a demandé en une phrase —
 * « la même avec un script python, il doit savoir le faire agir et me le montrer
 * en fonctionnement ». Un modèle qui écrit du Python sans jamais l'exécuter ne
 * fait que produire du texte plausible ; ici le code est LANCÉ, sa sortie est
 * affichée, et son erreur réelle revient au modèle pour qu'il corrige.
 *
 * CE QUI TOURNE : CPython compilé en WebAssembly (Pyodide), embarqué dans les
 * assets de l'APK par `scripts/copier-pyodide.mjs` — donc AUCUN CDN au lancement.
 * Le chargement est PARESSEUX : il ne coûte rien tant qu'aucun script n'est
 * demandé, et il n'est tenté qu'une fois (la promesse est mémorisée, et remise à
 * zéro si elle échoue, pour qu'un second essai soit possible).
 *
 * DEUX LIMITES DITES HONNÊTEMENT, PARCE QU'ELLES SE VERRAIENT :
 *  1. Un script qui BOUCLE À L'INFINI ne peut pas être interrompu : sans
 *     `SharedArrayBuffer` (donc sans isolation cross-origin dans la WebView),
 *     Pyodide n'expose pas `setInterruptBuffer`. On ne prétend donc pas avoir un
 *     délai de garde : on MESURE la durée et on l'affiche, et le prompt du
 *     harnais interdit explicitement les boucles non bornées.
 *  2. Seule la bibliothèque STANDARD est embarquée (pas de numpy, pas de
 *     matplotlib) : `import numpy` échoue avec l'erreur réelle de Python, et
 *     `manifeste` dit noir sur blanc ce qui est embarqué et ce qui ne l'est pas.
 *
 * Tout est injectable : la vérification hors appareil simule Pyodide, donc le
 * contrat (capture de sortie, erreur exacte, chargement unique, échec propre) se
 * teste sans WASM et sans navigateur.
 */

/** Ce que le module sait de Pyodide — réduit à ce qu'on appelle VRAIMENT. */
export type Pyodide = {
  /** Version de Pyodide (« 0.29.4 »). */
  version?: string;
  /** Version de Python (« 3.13.2 »). */
  runPythonAsync: (code: string) => Promise<unknown>;
  setStdout: (options: { batched: (texte: string) => void }) => void;
  setStderr: (options: { batched: (texte: string) => void }) => void;
};

export type ResultatPython = {
  ok: boolean;
  /** Ce que le script a écrit sur la sortie standard (et ses avertissements). */
  sortie: string;
  /** Le message d'erreur de Python — avec `File "<exec>", line N` — ou null. */
  erreur: string | null;
  /** Durée RÉELLE de l'exécution, en millisecondes (mesurée, pas estimée). */
  ms: number;
  /** Vrai si c'est le premier appel (le chargement de Python était compris). */
  premierAppel: boolean;
};

export type ExecuteurPython = (code: string) => Promise<ResultatPython>;

export type EtatPython = {
  charge: boolean;
  versionPyodide: string | null;
  versionPython: string | null;
  /** Erreur du dernier chargement, si le chargement a échoué. */
  erreur: string | null;
};

/** Le manifeste écrit à la construction : ce qui est RÉELLEMENT embarqué. */
export type ManifestePyodide = {
  pyodide: string;
  python: string | null;
  total: number;
  paquetsEmbarques: string[];
  fichiers: { nom: string; octets: number }[];
};

export type OptionsExecuteur = {
  /** Charge Pyodide (injectable : les tests fournissent un simulacre). */
  charger: () => Promise<Pyodide>;
  maintenant?: () => number;
  /** Durée maximale accordée au CHARGEMENT (le chargement, lui, peut expirer). */
  delaiChargementMs?: number;
};

const DELAI_CHARGEMENT_MS = 120_000;

/**
 * Enveloppe une promesse d'un délai. `null` = délai dépassé. Sert au CHARGEMENT
 * seulement : un chargement qui ne rend jamais la main doit être dit, pas subi.
 */
async function avecDelai<T>(promesse: Promise<T>, ms: number): Promise<T | null> {
  let minuteur: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promesse,
      new Promise<null>((resoudre) => {
        minuteur = setTimeout(() => resoudre(null), ms);
      }),
    ]);
  } finally {
    if (minuteur !== null) clearTimeout(minuteur);
  }
}

/** Le texte d'une erreur, quelle que soit sa forme (Error, chaîne, objet). */
function texte(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function creerExecuteurPython(options: OptionsExecuteur): ExecuteurPython & {
  etat: () => EtatPython;
} {
  const maintenant = options.maintenant ?? (() => Date.now());
  const delaiChargement = options.delaiChargementMs ?? DELAI_CHARGEMENT_MS;

  let pyodide: Pyodide | null = null;
  let enCours: Promise<Pyodide> | null = null;
  let erreurChargement: string | null = null;
  let versionPyodide: string | null = null;
  let versionPython: string | null = null;

  const charger = async (): Promise<Pyodide> => {
    if (pyodide) return pyodide;
    if (!enCours) {
      enCours = (async () => {
        const charge = await avecDelai(options.charger(), delaiChargement);
        if (charge === null) {
          throw new Error(
            `le moteur Python n'a pas fini de se charger après ${Math.round(delaiChargement / 1000)} s. ` +
              "L'appareil manque peut-être de mémoire : ferme d'autres applications et réessaie.",
          );
        }
        pyodide = charge;
        versionPyodide = charge.version ?? null;
        versionPython = await lireVersionPython(charge);
        erreurChargement = null;
        return charge;
      })().catch((e) => {
        // On AUTORISE un nouvel essai : un échec de chargement (mémoire, fichier
        // manquant) ne doit pas condamner la session.
        enCours = null;
        erreurChargement = texte(e);
        throw e instanceof Error ? e : new Error(erreurChargement);
      });
    }
    return enCours;
  };

  const executrice = (async (code: string): Promise<ResultatPython> => {
    const premierAppel = pyodide === null;
    const debut = maintenant();
    const lignes: string[] = [];
    const erreursSortie: string[] = [];

    let instance: Pyodide;
    try {
      instance = await charger();
    } catch (e) {
      return {
        ok: false,
        sortie: "",
        erreur: `Python n'a pas pu démarrer : ${texte(e)}`,
        ms: Math.max(0, maintenant() - debut),
        premierAppel,
      };
    }

    // La sortie du script est capturée PAR LIGNE : c'est ce que l'écran affiche,
    // et c'est ce qui sert de preuve quand un critère dit « le script affiche 4 ».
    instance.setStdout({ batched: (t) => lignes.push(t.replace(/\n$/, "")) });
    instance.setStderr({ batched: (t) => erreursSortie.push(t.replace(/\n$/, "")) });

    try {
      await instance.runPythonAsync(code);
      const sortie = [...lignes, ...erreursSortie].join("\n");
      return { ok: true, sortie, erreur: null, ms: Math.max(0, maintenant() - debut), premierAppel };
    } catch (e) {
      // L'erreur de Python est reprise TELLE QUELLE : elle porte le fichier, le
      // numéro de ligne et la cause. C'est ce que le modèle doit lire pour
      // corriger, et ce que l'utilisateur doit voir — jamais un message maison.
      return {
        ok: false,
        sortie: [...lignes, ...erreursSortie].join("\n"),
        erreur: texte(e),
        ms: Math.max(0, maintenant() - debut),
        premierAppel,
      };
    }
  }) as ExecuteurPython & { etat: () => EtatPython };

  executrice.etat = () => ({
    charge: pyodide !== null,
    versionPyodide,
    versionPython,
    erreur: erreurChargement,
  });
  return executrice;
}

/** `sys.version` réellement embarqué — affiché, jamais écrit en dur. */
async function lireVersionPython(instance: Pyodide): Promise<string | null> {
  try {
    const v = await instance.runPythonAsync("import sys; sys.version.split()[0]");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Charge le VRAI Pyodide depuis les assets de l'appli. `indexURL` pointe sur
 * `/pyodide/`, servi depuis l'APK (aucune requête sortante). L'import est
 * DYNAMIQUE et ignoré du bundler : le fichier est copié tel quel par
 * `scripts/copier-pyodide.mjs`, il n'a rien à faire dans le bundle JS.
 */
export async function chargerPyodideEmbarque(): Promise<Pyodide> {
  const url = "/pyodide/pyodide.mjs";
  const module = (await import(/* @vite-ignore */ url)) as { loadPyodide: (o: { indexURL: string }) => Promise<Pyodide> };
  if (typeof module.loadPyodide !== "function") {
    throw new Error(`${url} ne charge pas Pyodide (fichier absent de l'APK ?).`);
  }
  return module.loadPyodide({ indexURL: "/pyodide/" });
}

/** Lit le manifeste de construction : tailles MESURÉES, embarqué ou non. */
export async function lireManifestePyodide(fetcher?: typeof fetch): Promise<ManifestePyodide | null> {
  try {
    const reponse = await (fetcher ?? fetch)("/pyodide/manifeste.json");
    if (!reponse.ok) return null;
    return (await reponse.json()) as ManifestePyodide;
  } catch {
    return null;
  }
}

/** Taille lisible d'un manifeste (« 12,3 Mo »), ou null s'il n'y en a pas. */
export function tailleEmbarquee(manifeste: ManifestePyodide | null): string | null {
  if (!manifeste || typeof manifeste.total !== "number" || manifeste.total <= 0) return null;
  const mo = manifeste.total / 1e6;
  return `${mo.toFixed(1).replace(".", ",")} Mo`;
}
