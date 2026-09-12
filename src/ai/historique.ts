/**
 * HISTORIQUE DES APPS PRODUITES — conservées sur l'appareil, rechargeables sans
 * modèle, exportables en `.html` (P5 du brainstorm).
 *
 * Ce qui est gardé pour chaque app : le titre, la question posée, le modèle et
 * ses réglages, l'HTML final, CHAQUE version produite pendant le tour (une par
 * `write_app`, avec son pas et son état « coupée ou non »), et les métriques
 * MESURÉES du tour (débit, jetons, durée, pas, critères vérifiés, conclu ou
 * pas). Une version tronquée est stockée AVEC son verdict : on ne fait pas
 * passer une app coupée pour finie dans la galerie.
 *
 * Le stockage est IndexedDB (la WebView Android l'a, il tient des Mo sans
 * peine), derrière une interface injectable : les tests utilisent une version
 * en mémoire, et le module ne touche à aucune API du navigateur à l'import.
 *
 * L'export écrit le fichier dans `Download/` via @capacitor/filesystem sur
 * l'appareil (le même chemin que la trace, voir journal.ts), ou déclenche un
 * téléchargement Blob dans un navigateur. Rien ne sort de l'appareil.
 */
import type { EtatAchevement } from "./achevement.ts";

export type VersionApp = {
  /** Pas de la boucle qui a produit cette version. */
  pas: number;
  html: string;
  /** Vrai si la production a été coupée par le budget : stockée telle quelle, marquée. */
  tronque: boolean;
  /** Jetons produits pour cette version ; `null` si le moteur ne l'a pas dit. */
  jetons: number | null;
  date: number;
};

export type MetriquesTour = {
  tokParSeconde: number | null;
  /** Somme des jetons prédits sur le tour ; `null` si aucun bilan. */
  jetonsProduits: number | null;
  dureeMs: number | null;
  pasUtilises: number;
  /** « 2/3 » — critères vérifiés sur total ; « — » sans contrat. */
  criteres: string;
  conclu: boolean;
  tronque: boolean;
};

export type AppEnregistree = {
  id: string;
  date: number;
  titre: string;
  question: string;
  modele: string;
  reglages: { nCtx: number; nBatch: number; nThreads: number };
  html: string;
  versions: VersionApp[];
  metriques: MetriquesTour;
};

/** Ce qu'on attend d'un stockage — trois opérations, simulables. */
export type StockageApps = {
  toutes: () => Promise<AppEnregistree[]>;
  ecrire: (app: AppEnregistree) => Promise<void>;
  supprimer: (id: string) => Promise<void>;
};

export const NOM_BASE = "studio-local";
export const NOM_TABLE = "apps";
/** Au-delà, les plus anciennes sont effacées : la galerie n'est pas une archive infinie. */
export const MAX_APPS = 60;

/** Stockage en MÉMOIRE — pour les tests, et repli si IndexedDB est indisponible. */
export function stockageMemoire(initial: AppEnregistree[] = []): StockageApps {
  const table = new Map(initial.map((a) => [a.id, a]));
  return {
    toutes: async () => [...table.values()],
    ecrire: async (app) => {
      table.set(app.id, app);
    },
    supprimer: async (id) => {
      table.delete(id);
    },
  };
}

/** Ouvre (ou crée) la base IndexedDB. Rejette si l'API est absente : l'appelant se replie. */
function ouvrirBase(): Promise<IDBDatabase> {
  return new Promise((resoudre, rejeter) => {
    if (typeof indexedDB === "undefined") {
      rejeter(new Error("IndexedDB indisponible"));
      return;
    }
    const req = indexedDB.open(NOM_BASE, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(NOM_TABLE)) {
        req.result.createObjectStore(NOM_TABLE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resoudre(req.result);
    req.onerror = () => rejeter(req.error ?? new Error("ouverture IndexedDB refusée"));
  });
}

function requete<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resoudre, rejeter) => {
    r.onsuccess = () => resoudre(r.result);
    r.onerror = () => rejeter(r.error ?? new Error("requête IndexedDB en échec"));
  });
}

/** Le stockage RÉEL : IndexedDB, base `studio-local`, table `apps`. */
export function stockageIndexedDB(): StockageApps {
  const avec = async <T>(mode: IDBTransactionMode, f: (t: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const base = await ouvrirBase();
    try {
      return await requete(f(base.transaction(NOM_TABLE, mode).objectStore(NOM_TABLE)));
    } finally {
      base.close();
    }
  };
  return {
    toutes: () => avec("readonly", (t) => t.getAll() as IDBRequest<AppEnregistree[]>),
    ecrire: async (app) => {
      await avec("readwrite", (t) => t.put(app));
    },
    supprimer: async (id) => {
      await avec("readwrite", (t) => t.delete(id));
    },
  };
}

/** Le stockage par défaut : IndexedDB si la WebView l'offre, sinon la mémoire (et on le dit). */
let stockageParDefaut: StockageApps | null = null;
export function stockageApps(): StockageApps {
  if (stockageParDefaut) return stockageParDefaut;
  stockageParDefaut = typeof indexedDB === "undefined" ? stockageMemoire() : stockageIndexedDB();
  return stockageParDefaut;
}

/** « 2/3 » ou « — » : le compte de critères tel qu'il sera affiché dans la galerie. */
export function criteresLisibles(achevement: EtatAchevement | null | undefined): string {
  if (!achevement || achevement.criteres.length === 0) return "—";
  const ok = achevement.criteres.filter((c) => c.etat === "ok").length;
  return `${ok}/${achevement.criteres.length}`;
}

/** Enregistre une app (remplace si même id) et borne la galerie aux `MAX_APPS` plus récentes. */
export async function enregistrerApp(app: AppEnregistree, stockage: StockageApps = stockageApps()): Promise<void> {
  await stockage.ecrire(app);
  const toutes = await stockage.toutes();
  if (toutes.length > MAX_APPS) {
    const enTrop = [...toutes].sort((x, y) => x.date - y.date).slice(0, toutes.length - MAX_APPS);
    for (const a of enTrop) await stockage.supprimer(a.id);
  }
}

/** Les apps, les plus récentes d'abord. Ne lève jamais : une galerie illisible est vide, pas fatale. */
export async function listerApps(stockage: StockageApps = stockageApps()): Promise<AppEnregistree[]> {
  try {
    return (await stockage.toutes()).sort((x, y) => y.date - x.date);
  } catch {
    return [];
  }
}

export async function supprimerApp(id: string, stockage: StockageApps = stockageApps()): Promise<void> {
  await stockage.supprimer(id);
}

/**
 * Nom de fichier d'export : titre nettoyé + date, en `.html`. Sans caractère
 * qu'un système de fichiers refuserait, et jamais vide.
 */
export function nomFichierExport(app: Pick<AppEnregistree, "titre" | "date">): string {
  const base = app.titre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40);
  const d = new Date(app.date);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const horodate = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  return `${base || "app"}-${horodate}.html`;
}

/** Ce qu'on attend du plugin Filesystem pour écrire l'export (simulable). */
export type EcritureFichier = (o: { path: string; data: string; directory: string; encoding: string; recursive: boolean }) => Promise<unknown>;

/**
 * Exporte l'HTML d'une app. Sur l'appareil : `Download/<nom>.html` via le plugin
 * Filesystem (repli sur `Documents/`) — le chemin lisible est rendu. Dans un
 * navigateur : téléchargement Blob. Toute erreur remonte en clair à l'appelant.
 */
export async function exporterHtml(
  app: AppEnregistree,
  options: { natif: boolean; ecrire?: EcritureFichier; document?: Document } = { natif: false },
): Promise<string> {
  const nom = nomFichierExport(app);
  if (options.natif) {
    const ecrire =
      options.ecrire ??
      (async (o) => {
        const { Filesystem } = await import("@capacitor/filesystem");
        return (Filesystem as unknown as { writeFile: EcritureFichier }).writeFile(o);
      });
    const candidats = [
      { directory: "EXTERNAL_STORAGE", path: `Download/${nom}`, lisible: `/sdcard/Download/${nom}` },
      { directory: "DOCUMENTS", path: nom, lisible: `/sdcard/Documents/${nom}` },
    ];
    const refus: string[] = [];
    for (const c of candidats) {
      try {
        await ecrire({ path: c.path, data: app.html, directory: c.directory, encoding: "utf8", recursive: true });
        return c.lisible;
      } catch (e) {
        refus.push(`${c.lisible} → ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`export impossible : ${refus.join(" ; ")}`);
  }
  const doc = options.document ?? (typeof document !== "undefined" ? document : null);
  if (!doc || typeof URL === "undefined" || typeof Blob === "undefined") {
    throw new Error("export impossible : ni système de fichiers natif, ni navigateur");
  }
  const url = URL.createObjectURL(new Blob([app.html], { type: "text/html" }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = nom;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return nom;
}
