/**
 * Tests de la TRACE (src/ai/journal.ts) — sans Android, sans Capacitor.
 *
 * Ce qui est protégé ici, et pourquoi ça compte : l'utilisateur n'a que son
 * téléphone. Cette trace est le SEUL moyen de savoir où le chargement s'est
 * arrêté. Trois propriétés, donc, doivent tenir à tout prix :
 *
 *  1. LE FICHIER EST CRÉÉ AU DÉMARRAGE, avec un en-tête qui porte la version de
 *     l'appli : c'est ce qui prouve que l'écriture fonctionne AVANT d'avoir
 *     besoin du journal, et ce qui dit quel build a produit la trace ;
 *  2. UN EMPLACEMENT REFUSÉ N'ARRÊTE RIEN : on passe au suivant, et l'erreur
 *     BRUTE du refus est conservée (EACCES, « Operation not permitted » et
 *     « stockage non monté » ne veulent pas dire la même chose) ;
 *  3. LE JOURNAL NE PEUT JAMAIS BLOQUER LE CHARGEMENT : chaque écriture a un
 *     délai maximal, les échecs sont comptés, et aucune fonction ne lève.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATS_JOURNAL,
  MAX_ECHECS_SUIVIS,
  TAILLE_MAX_JOURNAL,
  VERSION_APP,
  demarrerJournal,
  etatJournal,
  journaliser,
  ligneJournal,
  noter,
  reinitialiserJournal,
  type CandidatJournal,
  type PluginJournal,
} from "./journal.ts";

/** Un plugin fichiers SIMULÉ, en mémoire : rien ne touche au disque. */
function fauxPlugin(options: { enPanne?: string[]; jamaisDeReponse?: boolean } = {}) {
  const fichiers = new Map<string, string>();
  const appels: string[] = [];
  const cle = (directory: string, path: string) => `${directory}:${path}`;
  /** Rien ne répond : simule un appel natif qui ne rend JAMAIS la main. */
  const muet = () => new Promise<never>(() => {});
  const plugin: PluginJournal = {
    writeFile: async ({ directory, path, data }) => {
      appels.push(`writeFile ${cle(directory, path)}`);
      if (options.jamaisDeReponse) return muet();
      if (options.enPanne?.includes(directory)) throw new Error("EACCES (Permission denied)");
      fichiers.set(cle(directory, path), data);
      return {};
    },
    appendFile: async ({ directory, path, data }) => {
      appels.push(`appendFile ${cle(directory, path)}`);
      if (options.jamaisDeReponse) return muet();
      if (options.enPanne?.includes(directory)) throw new Error("EACCES (Permission denied)");
      const precedente = fichiers.get(cle(directory, path));
      if (precedente === undefined) throw new Error("no such file or directory");
      fichiers.set(cle(directory, path), precedente + data);
    },
    mkdir: async () => ({}),
    stat: async ({ directory, path }) => {
      const contenu = fichiers.get(cle(directory, path));
      if (contenu === undefined) throw new Error("no such file or directory");
      return { size: contenu.length };
    },
    deleteFile: async ({ directory, path }) => {
      fichiers.delete(cle(directory, path));
    },
    getUri: async ({ directory, path }) => ({
      uri: `file:///simule/${cle(directory, path)}`,
    }),
  };
  return { plugin, fichiers, appels, lire: (c: CandidatJournal) => fichiers.get(cle(c.directory, c.path)) ?? "" };
}

/** Un seul candidat, pour que les tests ne dépendent pas de l'ordre réel. */
const UN_CANDIDAT: CandidatJournal[] = [
  {
    directory: "EXTERNAL_STORAGE",
    path: "Download/journal-studio.txt",
    cheminLisible: "/sdcard/Download/journal-studio.txt",
    visible: true,
  },
];

/** Horloge figée : les horodatages sont vérifiables au caractère près. */
function horlogeFigee(ms = Date.UTC(2026, 8, 12, 16, 20, 31, 123)) {
  return () => new Date(ms);
}

test("ligneJournal : horodaté à la seconde et au millième, sur une seule ligne", () => {
  const date = new Date(2026, 8, 12, 18, 20, 31, 7);
  assert.equal(ligneJournal("chargement demandé", date), "[2026-09-12 18:20:31.007] chargement demandé\n");
});

test("la trace est créée au démarrage, avec la version, et les lignes s'ajoutent dans l'ordre", async () => {
  reinitialiserJournal();
  const { plugin, lire, appels } = fauxPlugin();
  const etat = await demarrerJournal({
    plugin,
    candidats: UN_CANDIDAT,
    maintenant: horlogeFigee(),
  });

  assert.equal(etat.actif, true, "l'emplacement a accepté l'écriture");
  assert.equal(etat.chemin, "/sdcard/Download/journal-studio.txt");
  assert.equal(etat.visible, true, "Download est ouvrable par un gestionnaire de fichiers");
  assert.ok(etat.cheminReel?.startsWith("file:///"), "le chemin absolu réel est conservé");

  const apresDemarrage = lire(UN_CANDIDAT[0]);
  assert.match(apresDemarrage, /STUDIO LOCAL — trace de démarrage/, "en-tête présent");
  assert.ok(apresDemarrage.includes(VERSION_APP), "la version de l'appli est en tête de trace");
  assert.match(apresDemarrage, /démarrage de l'application/, "la ligne de démarrage est écrite");

  await journaliser("première étape");
  await journaliser("deuxième étape");
  const contenu = lire(UN_CANDIDAT[0]);
  assert.ok(
    contenu.indexOf("démarrage de l'application") < contenu.indexOf("première étape"),
    "l'ordre des lignes est celui des appels",
  );
  assert.ok(contenu.indexOf("première étape") < contenu.indexOf("deuxième étape"));
  assert.equal(appels.filter((a) => a.startsWith("appendFile")).length, 2, "deux ajouts, pas plus");
});

test("un emplacement refusé ne fait pas échouer la trace : on passe au suivant, refus consigné avec l'erreur BRUTE", async () => {
  reinitialiserJournal();
  const { plugin, lire } = fauxPlugin({ enPanne: ["EXTERNAL_STORAGE"] });
  const candidats: CandidatJournal[] = [
    UN_CANDIDAT[0],
    {
      directory: "DOCUMENTS",
      path: "journal-studio.txt",
      cheminLisible: "/sdcard/Documents/journal-studio.txt",
      visible: true,
    },
  ];
  const etat = await demarrerJournal({ plugin, candidats, maintenant: horlogeFigee() });

  assert.equal(etat.actif, true, "le second emplacement a pris le relais");
  assert.equal(etat.chemin, "/sdcard/Documents/journal-studio.txt");
  assert.equal(etat.refus.length, 1, "un refus, conservé");
  assert.equal(etat.refus[0].chemin, "/sdcard/Download/journal-studio.txt");
  assert.match(etat.refus[0].erreur, /EACCES/, "l'erreur brute du plugin est conservée telle quelle");
  assert.match(lire(candidats[1]), /trace de démarrage/, "le fichier du second emplacement existe");
});

test("aucun emplacement n'accepte : la trace est déclarée indisponible, TOUS les refus sont là, et rien ne lève", async () => {
  reinitialiserJournal();
  const { plugin } = fauxPlugin({ enPanne: CANDIDATS_JOURNAL.map((c) => c.directory) });
  const etat = await demarrerJournal({ plugin, maintenant: horlogeFigee() });

  assert.equal(etat.actif, false, "pas de trace : on le DIT au lieu de faire semblant");
  assert.equal(etat.chemin, null);
  assert.equal(etat.refus.length, CANDIDATS_JOURNAL.length, "tous les emplacements ont été essayés");
  // Et écrire une ligne ensuite ne lève rien, ne tente rien.
  await journaliser("une ligne qui n'ira nulle part");
  assert.equal(etatJournal().actif, false);
  assert.equal(etatJournal().erreurs.length, 0, "aucune nouvelle erreur : on n'essaie même plus");
});

test("hors Android (pas de plugin) : la trace est indisponible, et le démarrage ne lève pas", async () => {
  reinitialiserJournal();
  // Aucun plugin injecté : journal.ts tentera `import("@capacitor/filesystem")`,
  // qui échoue en Node — c'est exactement le cas d'un build navigateur.
  const etat = await demarrerJournal({ candidats: UN_CANDIDAT, maintenant: horlogeFigee() });
  assert.equal(etat.actif, false);
  assert.ok(etat.refus.length >= 1, "l'échec est consigné au lieu d'être avalé");
});

test("une écriture qui ne rend JAMAIS la main ne retient pas plus que le délai", async () => {
  // 1) L'écriture de l'EN-TÊTE qui ne répond pas : on abandonne l'emplacement
  //    plutôt que d'attendre indéfiniment un plugin muet.
  reinitialiserJournal();
  const muet = fauxPlugin({ jamaisDeReponse: true });
  const debut = Date.now();
  const etat = await demarrerJournal({
    plugin: muet.plugin,
    candidats: UN_CANDIDAT,
    delaiMs: 30,
    maintenant: horlogeFigee(),
  });
  const duree = Date.now() - debut;
  assert.equal(etat.actif, false, "l'écriture perdue n'est pas comptée comme réussie");
  assert.ok(duree < 1_000, `le délai maximal a joué (${duree} ms au lieu d'attendre indéfiniment)`);

  // 2) Une LIGNE qui ne répond pas : l'appelant est relâché dans le délai, et
  //    l'échec est consigné au lieu d'être avalé.
  reinitialiserJournal();
  const base = fauxPlugin();
  const lent: PluginJournal = { ...base.plugin, appendFile: () => new Promise<never>(() => {}) };
  await demarrerJournal({ plugin: lent, candidats: UN_CANDIDAT, delaiMs: 30, maintenant: horlogeFigee() });
  assert.equal(etatJournal().actif, true, "l'en-tête, lui, avait été écrit");
  const t0 = Date.now();
  await journaliser("une ligne qui ne répondra jamais");
  const dureeLigne = Date.now() - t0;
  assert.ok(dureeLigne >= 25, `l'écriture a bien été attendue un peu (${dureeLigne} ms)`);
  assert.ok(dureeLigne < 1_000, `puis abandonnée au délai (${dureeLigne} ms)`);
  assert.equal(etatJournal().erreurs.length, 1, "l'échec est consigné");
  assert.match(etatJournal().erreurs[0], /aucun retour en 30 ms/, "avec la cause réelle");
  assert.equal(etatJournal().actif, true, "un échec isolé ne coupe pas le journal");
});

test("des écritures en parallèle sont sérialisées et horodatées dans l'ordre", async () => {
  reinitialiserJournal();
  const { plugin, lire } = fauxPlugin();
  let t = 0;
  await demarrerJournal({
    plugin,
    candidats: UN_CANDIDAT,
    maintenant: () => new Date(Date.UTC(2026, 8, 12, 16, 20, 30, 0) + t++),
  });
  // `noter` est la version NON attendue : les trois appels partent d'affilée.
  noter("alpha");
  noter("beta");
  noter("gamma");
  // On attend la fin de la file d'écriture.
  await journaliser("delta");
  const contenu = lire(UN_CANDIDAT[0]);
  const positions = ["alpha", "beta", "gamma", "delta"].map((texte) => contenu.indexOf(texte));
  assert.ok(
    positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1])),
    `ordre préservé (${positions.join(", ")})`,
  );
  assert.equal(
    contenu.split("\n").filter((l) => l.startsWith("[")).length,
    5,
    "en-tête de démarrage + 4 lignes, toutes horodatées",
  );
});

test("un emplacement de repli est signalé comme NON ouvrable par l'utilisateur", async () => {
  reinitialiserJournal();
  const { plugin } = fauxPlugin();
  const candidats: CandidatJournal[] = [
    {
      directory: "DATA",
      path: "journal-studio.txt",
      cheminLisible: "mémoire privée de l'appli (getFilesDir())/journal-studio.txt",
      visible: false,
    },
  ];
  const etat = await demarrerJournal({ plugin, candidats, maintenant: horlogeFigee() });
  assert.equal(etat.actif, true);
  assert.equal(etat.visible, false, "l'appelant peut donc prévenir l'utilisateur");
});

test("une trace devenue énorme est reprise de zéro (effacée, jamais tronquée au milieu d'une ligne)", async () => {
  reinitialiserJournal();
  const { plugin, lire } = fauxPlugin();
  const candidat = UN_CANDIDAT[0];
  // On simule une trace déjà énorme au démarrage.
  await plugin.writeFile({
    directory: candidat.directory,
    path: candidat.path,
    data: "x".repeat(TAILLE_MAX_JOURNAL + 1),
    encoding: "utf8",
  });
  const etat = await demarrerJournal({ plugin, candidats: UN_CANDIDAT, maintenant: horlogeFigee() });
  assert.equal(etat.actif, true);
  const contenu = lire(candidat);
  assert.ok(!contenu.startsWith("xxx"), "l'ancien contenu a été effacé, pas conservé");
  assert.match(contenu, /trace de démarrage/, "la nouvelle session a son en-tête");
});

test("après trop d'échecs d'affilée, on arrête d'essayer (le chargement continue, sans surcoût)", async () => {
  reinitialiserJournal();
  const { plugin } = fauxPlugin();
  let ajouts = 0;
  const pluginQuiEchoueAPartirDeMaintenant: PluginJournal = {
    ...plugin,
    appendFile: async () => {
      ajouts += 1;
      throw new Error("IOException: No space left on device");
    },
  };
  await demarrerJournal({
    plugin: pluginQuiEchoueAPartirDeMaintenant,
    candidats: UN_CANDIDAT,
    maintenant: horlogeFigee(),
  });
  for (let i = 0; i < MAX_ECHECS_SUIVIS + 2; i++) await journaliser(`ligne ${i}`);
  assert.equal(ajouts, MAX_ECHECS_SUIVIS, "on s'arrête au nombre d'échecs prévu");
  assert.equal(etatJournal().actif, false, "et l'état le DIT");
  assert.ok(
    etatJournal().erreurs.some((e) => /No space left/.test(e)),
    "l'erreur brute est conservée",
  );
});

test("le démarrage de la trace a un plafond TOTAL : une recherche qui ne répond à rien ne dure pas indéfiniment", async () => {
  // Sans ce plafond, 5 emplacements × 3 appels × 1,5 s feraient payer ~22 s à la
  // première ligne de trace — donc au chargement, qui l'attend. Le diagnostic
  // deviendrait la panne qu'il décrit.
  reinitialiserJournal();
  const { plugin } = fauxPlugin({ jamaisDeReponse: true });
  const debut = Date.now();
  const etat = await demarrerJournal({
    plugin,
    delaiMs: 40,
    delaiTotalMs: 120,
    maintenant: horlogeFigee(),
  });
  const duree = Date.now() - debut;
  assert.equal(etat.actif, false, "aucun emplacement n'a répondu");
  assert.ok(duree < 1_000, `démarrage borné (${duree} ms au lieu de ~22 s)`);
  assert.ok(
    etat.refus.some((r) => /délai total de recherche dépassé/.test(r.erreur)),
    "et la raison du renoncement est consignée",
  );
  assert.equal(etat.refus.length, CANDIDATS_JOURNAL.length, "tous les emplacements sont rendus compte");
});
