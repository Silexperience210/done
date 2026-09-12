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
 * DEUX CHOSES ONT ÉTÉ AJOUTÉES APRÈS UN ÉCHEC RÉEL SUR TÉLÉPHONE (8,01 Go) :
 *
 *  1. LA REPRISE PAR `Range`. Un modèle de 8 Go demandait dix minutes de
 *     téléchargement ; la moindre coupure repartait de zéro, et un serveur qui
 *     refuse à 90 % faisait perdre les 7,2 Go déjà écrits. Désormais le fichier
 *     partiel est CONSERVÉ et la requête suivante demande `Range: bytes=<déjà>`,
 *     donc `accept-ranges: bytes` sert enfin à quelque chose. Si le serveur
 *     ignore l'en-tête (réponse 200 au lieu de 206), on repart proprement de
 *     zéro plutôt que d'écrire au mauvais endroit.
 *
 *  2. LES ESSAIS RÉPÉTÉS SUR 429 / 5xx / coupure réseau. Le refus observé était
 *     un HTTP 429 (« trop de requêtes »), c'est-à-dire un état PASSAGER lié à
 *     l'adresse IP : réessayer quelques secondes plus tard est la bonne réponse.
 *     `Retry-After` est respecté quand le serveur le donne. Un 4xx définitif
 *     (404, 403) n'est PAS réessayé : il échoue tout de suite, en nommant l'URL.
 */
import { modeleGguf } from "./moteurNatif.ts";
import type { LocalModelId } from "./types.ts";

/** Morceau écrit par appel : 2 Mio, comme l'import (même compromis). */
export const TAILLE_MORCEAU = 2 * 1024 * 1024;

/** Nombre total de passes (une passe = une requête HTTP). */
export const MAX_ESSAIS = 4;

/** Attente du premier essai avant réessai ; ×3 à chaque fois. */
export const ATTENTE_BASE_MS = 5000;

const ATTENTE_MAX_MS = 120_000;
const TOLERANCE_TAILLE = 0.02;
const SOUS_DOSSIER = "Documents";

export type ProgresTelechargement = {
  octetsRecus: number;
  octetsTotal: number;
  morceaux: number;
  /** Octets déjà sur le disque au début de cette passe (0 : pas de reprise). */
  repris: number;
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

export type ResultatTelechargement = { octets: number; chemin: string; essais: number };

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
  /** Attente entre deux essais (testable : on n'attend pas 5 s pour de vrai). */
  attendre?: (ms: number) => Promise<void>;
  /**
   * Taille attendue du fichier, en octets. Défaut : celle de la table des modèles
   * (398 Mo pour le 0,5B, 8,01 Go pour le 30B). Injectable POUR LES TESTS
   * uniquement : sans ça, vérifier la reprise par `Range` demanderait d'écrire
   * 398 Mo de données de test.
   */
  octetsAttendus?: number;
};

/**
 * Une erreur qu'un nouvel essai peut corriger (429, 5xx, réseau coupé).
 */
class ErreurRepetable extends Error {
  delaiMs: number | null;
  constructor(message: string, delaiMs: number | null = null) {
    super(message);
    this.name = "ErreurRepetable";
    this.delaiMs = delaiMs;
  }
}

/** Un refus définitif (404, 403, WebView sans flux) : réessayer ne changerait rien. */
class ErreurDefinitive extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErreurDefinitive";
  }
}

/**
 * Une erreur d'ÉCRITURE locale (espace plein, permission). Réessayer ne la
 * corrigerait pas et ferait perdre du temps : elle remonte telle quelle.
 */
class ErreurEcriture extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErreurEcriture";
  }
}

/**
 * Message d'un refus HTTP. À part et exporté parce que c'est LUI que l'utilisateur
 * lit : il doit dire ce qui s'est passé ET quoi faire, sans jargon.
 */
export function messageRefus(statut: number, url: string): string {
  if (statut === 429) {
    return (
      `le serveur a refusé la requête (HTTP 429 : trop de requêtes depuis cette adresse) pour ${url}. ` +
      "C'est presque toujours une adresse IP partagée (VPN, réseau public) que le serveur limite : " +
      "coupe le VPN ou passe en données mobiles, puis relance — le téléchargement reprendra où il s'est arrêté."
    );
  }
  if (statut === 503 || statut >= 500) {
    return `le serveur est momentanément indisponible (HTTP ${statut}) pour ${url} : nouvel essai en cours.`;
  }
  return `le téléchargement a été refusé par le serveur (HTTP ${statut}) pour ${url}`;
}

/** Délai avant nouvel essai : `Retry-After` s'il est donné, sinon attente croissante. */
export function delaiEssai(enteteRetryAfter: string | null, essai: number, maintenantMs: number): number {
  if (enteteRetryAfter) {
    const secondes = Number(enteteRetryAfter.trim());
    if (Number.isFinite(secondes) && secondes >= 0) return Math.min(secondes * 1000, ATTENTE_MAX_MS);
    const date = Date.parse(enteteRetryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - maintenantMs, ATTENTE_MAX_MS));
  }
  return Math.min(ATTENTE_BASE_MS * 3 ** (essai - 1), ATTENTE_MAX_MS);
}

/** Octets déjà écrits pour ce fichier, ou 0 s'il n'existe pas. Ne lève jamais. */
async function tailleExistante(plugin: PluginEcriture, chemin: string, directory: unknown): Promise<number> {
  try {
    const info = await plugin.stat({ path: chemin, directory });
    return typeof info?.size === "number" && info.size > 0 ? info.size : 0;
  } catch {
    return 0;
  }
}

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
  const attendu = options?.octetsAttendus ?? modele.octets;
  const fetcher = options?.fetcher ?? fetch;
  const attendre = options?.attendre ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

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

  const effacer = async () => {
    try {
      await plugin.deleteFile({ path: chemin, directory });
    } catch {
      /* rien à effacer : cas nominal */
    }
  };

  let derniereErreur: Error | null = null;

  for (let essai = 1; essai <= MAX_ESSAIS; essai += 1) {
    // REPRISE : ce qui est déjà sur le disque est gardé et redemandé au serveur.
    let repris = await tailleExistante(plugin, chemin, directory);
    if (repris > attendu) {
      // Plus gros que le modèle attendu : ce n'est pas une reprise utile (autre
      // fichier, écriture précédente corrompue), on repart d'un état propre.
      await effacer();
      repris = 0;
    }

    try {
      const entetes: Record<string, string> = {};
      if (repris > 0) entetes.Range = `bytes=${repris}-`;
      const reponse = await fetcher(modele.url, {
        redirect: "follow",
        headers: entetes,
        signal: options?.signal,
      });

      if (reponse.status === 429 || reponse.status === 503 || reponse.status >= 500) {
        throw new ErreurRepetable(
          messageRefus(reponse.status, modele.url),
          delaiEssai(reponse.headers.get("retry-after"), essai, Date.now()),
        );
      }
      if (!reponse.ok) {
        // 404 / 403 : réessayer ne changera rien. On le dit tout de suite.
        throw new ErreurDefinitive(messageRefus(reponse.status, modele.url));
      }
      if (reponse.body === null) {
        throw new ErreurDefinitive(
          "ce WebView ne donne pas accès au corps de la réponse en flux : impossible d'écrire par morceaux.",
        );
      }
      // Le serveur a ignoré `Range` (200 au lieu de 206) : il renvoie le fichier
      // ENTIER depuis le début. Continuer à ajouter écrirait un fichier doublé.
      if (repris > 0 && reponse.status === 200) {
        await effacer();
        repris = 0;
      }

      let recus = repris;
      let morceaux = 0;
      let premier = repris === 0;
      let tampon: Uint8Array[] = [];
      let enAttente = 0;

      const ecrire = async (bloc: Uint8Array) => {
        const donnees = base64DepuisTampon(bloc.buffer as ArrayBuffer);
        // Une écriture qui échoue est un problème LOCAL (espace, permission) :
        // on l'étiquette pour ne pas la confondre avec une coupure réseau.
        try {
          if (premier) {
            await plugin.writeFile({ path: chemin, data: donnees, directory, recursive: true });
            premier = false;
          } else {
            await plugin.appendFile({ path: chemin, data: donnees, directory });
          }
        } catch (e) {
          throw new ErreurEcriture(
            `écriture impossible dans la mémoire de l'appli (${e instanceof Error ? e.message : String(e)}) — ` +
              "reste-t-il assez d'espace libre ?",
          );
        }
        morceaux += 1;
        onProgres?.({ octetsRecus: recus, octetsTotal: attendu, morceaux, repris });
      };

      const lecteur = reponse.body.getReader();
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
        onProgres?.({ octetsRecus: recus, octetsTotal: attendu, morceaux, repris });
      }
      if (enAttente > 0) {
        await ecrire(concatener(tampon, enAttente));
      }
    } catch (e) {
      derniereErreur = e instanceof Error ? e : new Error(String(e));
      // CE QUI SE RÉESSAIE, et ce qui ne se réessaie pas :
      //  - écriture locale (ErreurEcriture)  -> on s'arrête, ça ne se réparera pas
      //  - refus définitif  (ErreurDefinitive) -> 404/403, inutile d'insister
      //  - 429 / 5xx (ErreurRepetable)        -> on attend puis on retente
      //  - toute autre panne de LECTURE du flux (coupure réseau) -> on retente
      // Le fichier partiel est CONSERVÉ dans tous les cas : c'est lui qui permet
      // la reprise par `Range` à la passe suivante.
      if (e instanceof ErreurEcriture || e instanceof ErreurDefinitive) throw derniereErreur;
      if (essai < MAX_ESSAIS) {
        const delai = e instanceof ErreurRepetable ? (e.delaiMs ?? delaiEssai(null, essai, Date.now())) : delaiEssai(null, essai, Date.now());
        await attendre(delai);
      }
      continue;
    }

    // La taille est relue SUR LE DISQUE : c'est la seule preuve que le fichier
    // est complet. Fausse, on retente — la passe suivante ne demandera que ce
    // qui manque, grâce au `Range`.
    const relu = await tailleExistante(plugin, chemin, directory);
    const ecart = Math.abs(relu - attendu);
    if (ecart <= attendu * TOLERANCE_TAILLE) {
      return { octets: relu, chemin, essais: essai };
    }
    derniereErreur = new Error(
      `le fichier téléchargé fait ${tailleLisible(relu)} au lieu de ${tailleLisible(attendu)} : ` +
        "téléchargement incomplet. Relance : l'appli reprendra à l'endroit écrit.",
    );
    if (essai < MAX_ESSAIS) await attendre(delaiEssai(null, essai, Date.now()));
  }

  // Toutes les passes ont échoué : on nomme la dernière cause, telle quelle.
  const derniere = derniereErreur ?? new Error("le téléchargement n'a pas abouti");
  throw new Error(
    `${derniere.message}\n(${MAX_ESSAIS} essais ; le fichier partiel est conservé, une relance reprendra à l'endroit écrit.)`,
  );
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
