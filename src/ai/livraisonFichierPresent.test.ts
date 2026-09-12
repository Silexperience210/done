/**
 * Vérification du contrôle « LE FICHIER EST-IL DÉJÀ LÀ ? ».
 *
 * POURQUOI CE TEST EXISTE : constaté sur téléphone — « pourquoi je dois
 * télécharger à chaque fois ? ». Le 30B (8,01 Go) était déjà livré, le moteur
 * n'arrivait pas à l'ouvrir (mémoire vive), et l'appli interprétait cet échec
 * comme une ABSENCE de fichier : elle retéléchargeait huit gigas, échouait de la
 * même façon, et recommençait à l'essai suivant. Un échec de chargement n'est pas
 * une absence : quand le fichier est là, à la bonne taille, on ne touche pas au
 * réseau et on dit l'échec réel.
 *
 * Les trois cas sont couverts : fichier complet (aucun téléchargement), fichier
 * partiel (on télécharge pour compléter), rien du tout (on télécharge).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { chargerPuisTelecharger, type Livraison } from "./modeleLocal.ts";
import { modeleGguf } from "./moteurNatif.ts";
import type { EtatFichierModele } from "./modeleLocal.ts";

const ID = "coder05" as const;
const MODELE = modeleGguf(ID);

/** État d'un `chercherModele` : un seul emplacement, présent ou non. */
function etat(octets: number | null): EtatFichierModele {
  const emplacement = {
    chemin: `mémoire privée de l'appli / Documents/${MODELE.fichier}`,
    directory: "DATA",
    path: `Documents/${MODELE.fichier}`,
    octets,
    etat: octets === null ? ("absent" as const) : ("present" as const),
    erreur: null,
  };
  return { emplacements: [emplacement], trouves: octets === null ? [] : [{ ...emplacement }] };
}

/** Une livraison factice : le chargement échoue, on note ce qui est tenté. */
function livraison(
  options: { chargement: () => Promise<void>; fichier: number | null; reussiteApresTelechargement?: boolean },
): { livraison: Livraison; appels: string[] } {
  const appels: string[] = [];
  let chargements = 0;
  const l: Livraison = {
    id: ID,
    charger: async () => {
      chargements += 1;
      appels.push(`charger#${chargements}`);
      if (options.reussiteApresTelechargement && chargements > 1) return;
      await options.chargement();
    },
    telecharger: async () => {
      appels.push("telecharger");
    },
    chercher: async () => etat(options.fichier),
  };
  return { livraison: l, appels };
}

test("fichier COMPLET déjà là : aucun téléchargement, et l'échec réel est dit", async () => {
  const { livraison: l, appels } = livraison({
    chargement: async () => {
      throw new Error("Failed to initialize native context");
    },
    fichier: MODELE.octets,
  });

  await assert.rejects(
    () => chargerPuisTelecharger(l),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /est bien installé/, "on dit que le fichier est là");
      assert.match(m, /398 Mo|397 Mo/, "sa taille est citée");
      assert.match(m, /PAS retéléchargé|pas retéléchargé/i, "on dit que rien ne sera retéléchargé");
      assert.match(m, /Failed to initialize native context/, "l'échec RÉEL du moteur est repris tel quel");
      assert.match(m, /contexte plus petit/, "on oriente vers la mémoire, qui est la cause probable");
      return true;
    },
  );
  assert.deepEqual(appels, ["charger#1"], "le téléchargement n'est MÊME PAS tenté");
});

test("fichier PARTIEL (taille fausse) : on télécharge, pour compléter", async () => {
  const moitie = Math.round(MODELE.octets / 2);
  const { livraison: l, appels } = livraison({
    chargement: async () => {
      throw new Error("Failed to initialize native context");
    },
    fichier: moitie,
    reussiteApresTelechargement: true,
  });

  const resultat = await chargerPuisTelecharger(l);
  assert.deepEqual(appels, ["charger#1", "telecharger", "charger#2"], "on télécharge, puis on recharge une fois");
  assert.equal(resultat.dejaLa, false);
  assert.equal(resultat.erreurChargement, "Failed to initialize native context");
});

test("aucun fichier : on télécharge (comportement inchangé du premier lancement)", async () => {
  const { livraison: l, appels } = livraison({
    chargement: async () => {
      throw new Error("no such file");
    },
    fichier: null,
    reussiteApresTelechargement: true,
  });

  const resultat = await chargerPuisTelecharger(l);
  assert.deepEqual(appels, ["charger#1", "telecharger", "charger#2"]);
  assert.equal(resultat.dejaLa, false);
});

test("la recherche qui échoue ne bloque pas le téléchargement", async () => {
  const appels: string[] = [];
  let chargements = 0;
  const l: Livraison = {
    id: ID,
    charger: async () => {
      chargements += 1;
      appels.push(`charger#${chargements}`);
      if (chargements === 1) throw new Error("no such file");
    },
    telecharger: async () => {
      appels.push("telecharger");
    },
    chercher: async () => {
      throw new Error("plugin fichiers indisponible");
    },
  };

  const resultat = await chargerPuisTelecharger(l);
  assert.deepEqual(appels, ["charger#1", "telecharger", "charger#2"], "on ne peut pas conclure : on télécharge");
  assert.equal(resultat.dejaLa, false);
});
