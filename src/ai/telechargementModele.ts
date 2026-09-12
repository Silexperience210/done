/**
 * TÉLÉCHARGER LE MODÈLE DANS L'APPLI, SANS LE TÉLÉCHARGEUR CASSÉ.
 *
 * POURQUOI CE MODULE EXISTE : `Filesystem.downloadFile` (code legacy de
 * @capacitor/filesystem 8.1.3) ne rend pas la main sur l'appareil visé — c'est
 * écrit dans `session.ts`, et la trace native le confirme par l'autre bout (le
 * moteur cherche le modèle, tous les emplacements sont vides). Résultat : l'appli
 * ne sait pas faire entrer son propre modèle, et l'utilisateur doit passer par
 * Chrome puis par l'import (`importerModele.ts`).
 *
 * Ici, c'est la WebView elle-même qui télécharge : `fetch()` puis lecture du
 * corps EN FLUX, morceau par morceau, écrits directement dans la mémoire privée
 * de l'appli. Ce qui rend la chose possible, et qui a été vérifié sur le CDN du
 * Hub avant d'écrire ce fichier :
 *   - `access-control-allow-origin: *` sur le CDN après redirection (et l'origine
 *     « https://org.silexperience.studiolocal » est acceptée par huggingface.co) ;
 *   - `accept-ranges: bytes`.
 * Aucun plugin natif n'est donc nécessaire, et ça n'ajoute aucune dépendance.
 *
 * CE QUE ÇA NE FAIT PAS : pas de reprise après coupure (le fichier partiel est
 * effacé et on repart de zéro). Une reprise par `Range` est possible — l'en-tête
 * est là — mais elle se justifie quand quelqu'un l'aura mesurée sur une
 * connexion qui coupe ; tant que ce n'est pas le cas, un état propre vaut mieux
 * qu'un fichier à moitié écrit qui « a l'air » complet.
 */
import { modeleGguf } from "./moteurNatif.ts";
import type { LocalModelId } from "./types.ts";

/** Morceau écrit par appel : 2 Mio, comme l'import (même compromis). */
export const TAILLE_MORCEAU = 2 * 1024 * 1024;

const TOLERANCE_TAILLE = 0.02;
const SOUS_DOSSIER = "Documents";

export type ProgresTelechargement = {
  octetsRecus: number;
  octetsTotal: number;
  morceaux: number;
};

function tailleLisible(octets: number): string {
  if (octets >= 1e9) return `${(octets / 1e9).toFixed(2)} Go`;
  return `${(octets / 1e6).toFixed(0)} Mo`;
}

function base64DepuisTampon(tampon: ArrayBuffer): string {
  const octets = new Uint8Array(tampon);
  const BLOC = 8192;
  let intermediaire = "";
  for (let i = 0; i < octets.length; i += BLOC) {
    intermediaire += String.fromCharCode(...octets.subarray(i, Math.min(i + BLOC, octets.length)));
  }
  return btoa(intermediaire);
}

export type ResultatTelechargement = { octets: number; chemin: string };

/**
 * Le strict nécessaire du plugin de fichiers, injectable : c'est ce qui permet de
 * VÉRIFIER l'écriture par morceaux hors téléphone (`telechargementModele.test.ts`)
 * — un fichier de 400 Mo mal recollé ne se voit qu'au chargement du moteur.
 */
export type PluginEcriture = {
  writeFile: (o: { path: string; data: string; directory: unknown; recursive?: boolean }) => Promise<unknown>;
  appendFile: (o: { path: string; data: string; directory: unknown }) => Promise<unknown>;
  deleteFile: (o: { path: string; directory: unknown }) => Promise<unknown>;
  stat: (o: { path: string; directory: unknown }) => Promise<{ size: number }>;
};

export type OptionsTelechargement = {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  /** Plugin de fichiers (tests). Par défaut : le vrai `@capacitor/filesystem`. */
  plugin?: PluginEcriture;
  /** Dossier passé au plugin quand il est injecté (tests). Défaut : « DATA ». */
  directory?: unknown;
};

/**
 * Télécharge le modèle et l'écrit sous le nom EXACT que le moteur cherchera.
 * Lève une erreur rédigée pour l'utilisateur (réseau, taille, écriture).
 */
export async function telechargerModeleParFetch(
  id: LocalModelId,
  onProgres?: (p: ProgresTelechargement) => void,
  options?: OptionsTelechargement,
): Promise<ResultatTelechargement> {
  const modele = modeleGguf(id);
  const fetcher = options?.fetcher ?? fetch;

  const reponse = await fetcher(modele.url, { redirect: "follow", signal: options?.signal });
  if (!reponse.ok) {
    throw new Error(
      `le téléchargement a été refusé par le serveur (HTTP ${reponse.status} ${reponse.statusText}) ` +
        `pour ${modele.url}`,
    );
  }
  if (reponse.body === null) {
    throw new Error("ce WebView ne donne pas accès au corps de la réponse en flux : impossible d'écrire par morceaux.");
  }

  let plugin: PluginEcriture;
  let directory: unknown;
  if (options?.plugin) {
    plugin = options.plugin;
    directory = options.directory ?? "DATA";
  } else {
    const mod = await import("@capacitor/filesystem");
    plugin = mod.Filesystem as unknown as PluginEcriture;
    directory = mod.Directory.Data;
  }
  const chemin = `${SOUS_DOSSIER}/${modele.fichier}`;

  try {
    await plugin.deleteFile({ path: chemin, directory });
  } catch {
    /* rien à effacer : cas nominal */
  }

  const lecteur = reponse.body.getReader();
  let tampon: Uint8Array[] = [];
  let enAttente = 0;
  let recus = 0;
  let morceaux = 0;
  let premier = true;

  const ecrire = async (bloc: Uint8Array) => {
    const donnees = base64DepuisTampon(bloc.buffer as ArrayBuffer);
    if (premier) {
      await plugin.writeFile({ path: chemin, data: donnees, directory, recursive: true });
      premier = false;
    } else {
      await plugin.appendFile({ path: chemin, data: donnees, directory });
    }
    morceaux += 1;
    onProgres?.({ octetsRecus: recus, octetsTotal: modele.octets, morceaux });
  };

  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      if (!value) continue;
      // Un morceau peut dépasser la taille visée : on le découpe pour garder des
      // écritures régulières (et un avancement qui bouge vraiment).
      let reste = value;
      while (reste.length > 0) {
        const manque = TAILLE_MORCEAU - enAttente;
        const pris = reste.subarray(0, manque);
        tampon.push(pris);
        enAttente += pris.length;
        recus += pris.length;
        reste = reste.subarray(pris.length);
        if (enAttente >= TAILLE_MORCEAU) {
          await ecrire(concatener(tampon, enAttente));
          tampon = [];
          enAttente = 0;
        }
      }
      onProgres?.({ octetsRecus: recus, octetsTotal: modele.octets, morceaux });
    }
    if (enAttente > 0) {
      await ecrire(concatener(tampon, enAttente));
    }
  } catch (e) {
    // Un fichier à moitié écrit ferait croire à un modèle complet : on l'efface.
    try {
      await plugin.deleteFile({ path: chemin, directory });
    } catch {
      /* l'effacement ne doit pas masquer l'erreur d'origine */
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  const relu = await plugin.stat({ path: chemin, directory });
  if (Math.abs(relu.size - modele.octets) > modele.octets * TOLERANCE_TAILLE) {
    await plugin.deleteFile({ path: chemin, directory }).catch(() => {});
    throw new Error(
      `le fichier téléchargé fait ${tailleLisible(relu.size)} au lieu de ` +
        `${tailleLisible(modele.octets)} : téléchargement incomplet, il a été effacé. ` +
        "Relance (Wi-Fi conseillé).",
    );
  }

  return { octets: relu.size, chemin };
}

function concatener(morceaux: Uint8Array[], total: number): Uint8Array {
  const sortie = new Uint8Array(total);
  let position = 0;
  for (const m of morceaux) {
    sortie.set(m, position);
    position += m.length;
  }
  return sortie;
}
