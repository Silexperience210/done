/**
 * IMPORTER LE MODÈLE DÉJÀ TÉLÉCHARGÉ — la voie qui ne dépend d'aucun téléchargeur.
 *
 * POURQUOI CE MODULE EXISTE, et pourquoi ce n'est pas un contournement : sur
 * l'appareil visé, le téléchargement de l'appli (`Filesystem.downloadFile`, code
 * legacy de @capacitor/filesystem) ne rend pas la main — c'est écrit dans
 * `session.ts` (« un `downloadFile` cassé (c'est le cas sur l'appareil visé) »),
 * et la trace native le confirme de l'autre côté : le chargement atteint le
 * moteur, tous les emplacements sont vides, « AUCUN fichier trouvé ». Le modèle
 * n'arrive donc jamais sur le téléphone, quoi que fasse le moteur.
 *
 * Or l'utilisateur, lui, SAIT télécharger un fichier : Chrome le fait très bien,
 * et le fichier est déjà là (398 Mo dans le téléphone). Ce qu'il ne peut pas
 * faire, c'est le POSER dans la mémoire privée de l'appli — aucun gestionnaire
 * de fichiers n'y a accès. D'où ce module : il prend un fichier CHOISI PAR
 * L'UTILISATEUR (le sélecteur Android accorde la lecture du fichier choisi,
 * sans aucune permission de stockage) et l'écrit dans
 * `getFilesDir()/Documents/<nom exact attendu par le moteur>`.
 *
 * POURQUOI ÉCRIRE PAR MORCEAUX : le pont Capacitor transporte du texte. On lit
 * 2 Mio du fichier, on les encode en base64, on les écrit, on recommence. C'est
 * plus lent qu'un `cp` mais ça ne dépend de rien d'autre que de l'appli, et ça
 * affiche un avancement honnête. Aucune donnée ne transite par le réseau.
 *
 * CE QUI EST VÉRIFIÉ AVANT D'ÉCRIRE, parce qu'un fichier de 398 Mo écrit pour
 * rien est pire qu'un refus :
 *   - la TAILLE, à 2 % près, contre celle du modèle attendu (le nom du fichier
 *     est celui que le moteur cherchera, il est donc imposé, pas choisi) ;
 *   - la SIGNATURE « GGUF » sur les quatre premiers octets.
 * Et après écriture : la taille RELUE sur le disque, parce qu'un échec partiel
 * silencieux doit se voir ici et pas au chargement du moteur.
 */
import { modeleGguf, type ModeleGguf } from "./moteurNatif.ts";
import type { LocalModelId } from "./types.ts";

/** Morceau écrit par appel : 2 Mio. Compromis entre le nombre d'appels et la taille du pont. */
export const TAILLE_MORCEAU = 2 * 1024 * 1024;

/** Même tolérance que la vérification de livraison (`modeleLocal.ts`). */
const TOLERANCE_TAILLE = 0.02;

/** Sous-dossier où le moteur natif cherche le GGUF : getFilesDir()/Documents. */
const SOUS_DOSSIER = "Documents";

export type ProgresImport = {
  octetsEcrits: number;
  octetsTotal: number;
  morceaux: number;
};

/** Nom EXACT attendu par le moteur — c'est lui qu'on écrit, jamais celui du fichier source. */
export function nomFichierAttendu(id: LocalModelId): string {
  return modeleGguf(id).fichier;
}

/** La taille du fichier choisi correspond-elle au modèle attendu (±2 %) ? */
export function tailleAcceptable(vue: number, attendue: number): boolean {
  if (!Number.isFinite(vue) || vue <= 0) return false;
  return Math.abs(vue - attendue) <= attendue * TOLERANCE_TAILLE;
}

/** Octets lisibles, sans dépendre d'un autre module (message d'erreur autonome). */
function tailleLisible(octets: number): string {
  if (octets >= 1e9) return `${(octets / 1e9).toFixed(2)} Go`;
  return `${(octets / 1e6).toFixed(0)} Mo`;
}

/** Base64 d'un tampon, encodé par blocs : `String.fromCharCode(...)` explose au-delà. */
export function base64DepuisTampon(tampon: ArrayBuffer): string {
  const octets = new Uint8Array(tampon);
  const BLOC = 8192;
  let intermediaire = "";
  for (let i = 0; i < octets.length; i += BLOC) {
    intermediaire += String.fromCharCode(...octets.subarray(i, Math.min(i + BLOC, octets.length)));
  }
  return btoa(intermediaire);
}

export type ResultatImport = {
  /** Taille RELUE sur le disque après écriture. */
  octets: number;
  /** Chemin relatif écrit, tel que le moteur le trouvera. */
  chemin: string;
};

/**
 * Écrit le fichier choisi dans la mémoire privée de l'appli, sous le nom exact
 * attendu par le moteur. Lève une erreur RÉDIGÉE POUR L'UTILISATEUR (taille,
 * signature, écriture) : elle sera affichée telle quelle.
 */
export async function importerModeleDepuisFichier(
  fichier: File,
  id: LocalModelId,
  onProgres?: (p: ProgresImport) => void,
): Promise<ResultatImport> {
  const modele: ModeleGguf = modeleGguf(id);

  if (!tailleAcceptable(fichier.size, modele.octets)) {
    throw new Error(
      `ce fichier fait ${tailleLisible(fichier.size)} alors que le modèle ` +
        `« ${modele.nom} » en fait ${tailleLisible(modele.octets)} ` +
        `(${modele.octets} octets). Ce n'est pas le bon fichier : ` +
        `reprends le téléchargement sur ${modele.url}`,
    );
  }

  const tete = new Uint8Array(await fichier.slice(0, 4).arrayBuffer());
  const estGguf =
    tete[0] === 0x47 && tete[1] === 0x47 && tete[2] === 0x55 && tete[3] === 0x46; // « GGUF »
  if (!estGguf) {
    throw new Error(
      "ce fichier ne commence pas par « GGUF » : ce n'est pas un modèle llama.cpp " +
        "(un fichier .bin renommé ou une page HTML de téléchargement échoué, par exemple).",
    );
  }

  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const chemin = `${SOUS_DOSSIER}/${modele.fichier}`;

  // Un fichier partiel d'une tentative précédente feraient croire à un modèle
  // complet (`appendFile` ajouterait à la suite) : on part d'un état propre.
  try {
    await Filesystem.deleteFile({ path: chemin, directory: Directory.Data });
  } catch {
    /* rien à effacer : c'est le cas nominal */
  }

  let ecrits = 0;
  let premier = true;
  let morceaux = 0;
  for (let position = 0; position < fichier.size; position += TAILLE_MORCEAU) {
    const bloc = fichier.slice(position, Math.min(position + TAILLE_MORCEAU, fichier.size));
    const donnees = base64DepuisTampon(await bloc.arrayBuffer());
    if (premier) {
      // `recursive: true` crée getFilesDir()/Documents au passage : sans ça,
      // l'écriture échoue (le dossier n'existe pas encore après une
      // désinstallation/réinstallation).
      await Filesystem.writeFile({
        path: chemin,
        data: donnees,
        directory: Directory.Data,
        recursive: true,
      });
      premier = false;
    } else {
      await Filesystem.appendFile({ path: chemin, data: donnees, directory: Directory.Data });
    }
    ecrits += bloc.size;
    morceaux += 1;
    onProgres?.({ octetsEcrits: ecrits, octetsTotal: fichier.size, morceaux });
  }

  const relu = await Filesystem.stat({ path: chemin, directory: Directory.Data });
  if (!tailleAcceptable(relu.size, modele.octets)) {
    throw new Error(
      `le fichier écrit fait ${relu.size} octets au lieu de ${modele.octets} : ` +
        "l'écriture est incomplète. Vérifie l'espace libre du téléphone et recommence.",
    );
  }

  return { octets: relu.size, chemin };
}
