/**
 * Tests de la LIVRAISON du modèle — sans Android, sans llama.cpp, sans réseau.
 *
 * Ce qui est protégé ici, parce que c'est ce qui a coûté cher en vrai :
 *  - le modèle part bien dans `Directory.Data`/`Documents`, c'est-à-dire
 *    getFilesDir()/Documents/<fichier> — LE dossier que le plugin natif visite
 *    (un GGUF dans les assets de l'APK, c'était le bug : introuvable) ;
 *  - `Documents/` est créé AVANT le téléchargement (le plugin ne crée pas les
 *    dossiers parents et ignore `recursive`) ;
 *  - on ne re-télécharge pas 400 Mo si le fichier est déjà là et plausible ;
 *  - un téléchargement tronqué / un fichier introuvable / un échec réseau est
 *    REFUSÉ et rapporté clairement — jamais avalé ;
 *  - la progression remontée est réelle, et celle d'un autre fichier est ignorée ;
 *  - l'erreur brute du moteur natif est traduite en message ACTIONNABLE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cheminModele,
  cheminRelatif,
  DELAI_GARDE_MS,
  gardeDepassee,
  messageEchec,
  messageErreurActionnable,
  messageGarde,
  tailleLisible,
  taillePlausible,
  telechargerModele,
  type PluginFichiers,
  type ProgresFichier,
} from "./modeleLocal.ts";
import { MODELES_GGUF, modeleGguf } from "./moteurNatif.ts";
import type { ProgresChargement } from "./types.ts";

const TAILLE_05 = modeleGguf("coder05").octets; // 397 808 288

/**
 * Simulacre du plugin Filesystem. `tailles` est consommé dans l'ordre par
 * `stat` (le dernier est répété) : `null` signifie « fichier absent ».
 *
 * `telechargementBloque` : `downloadFile` ne rend JAMAIS la main — c'est le
 * téléchargement qui cale (Wi-Fi tombé), le cas que le délai de garde doit
 * transformer en message clair au lieu d'un écran mort.
 */
function pluginFactice(o: {
  tailles: (number | null)[];
  echecTelechargement?: string;
  telechargementBloque?: boolean;
  journal?: Record<string, unknown>[];
}): { plugin: PluginFichiers; journal: Record<string, unknown>[] } {
  const journal = o.journal ?? [];
  let appelsStat = 0;
  let ecouteur: ((p: ProgresFichier) => void) | null = null;

  const plugin: PluginFichiers = {
    mkdir: async (x) => {
      journal.push({ mkdir: x });
      return {};
    },
    stat: async (x) => {
      const n = appelsStat;
      appelsStat += 1;
      journal.push({ stat: x });
      const t = o.tailles[Math.min(n, o.tailles.length - 1)];
      if (t === null || t === undefined) throw new Error("fichier absent");
      return { size: t };
    },
    deleteFile: async (x) => {
      journal.push({ deleteFile: x });
    },
    downloadFile: async (x) => {
      journal.push({ downloadFile: x });
      if (o.echecTelechargement) throw new Error(o.echecTelechargement);
      if (o.telechargementBloque) {
        // Ne rend jamais la main : le « fichier » cesse de grossir.
        await new Promise<void>(() => {});
      }
      if (x.progress && ecouteur) {
        // Un évènement d'un AUTRE fichier ne doit pas compter…
        ecouteur({ url: "https://exemple/autre.gguf", bytes: 10, contentLength: 1000 });
        // …puis la progression réelle du fichier attendu.
        ecouteur({ url: x.url, bytes: 50, contentLength: 100 });
        ecouteur({ url: x.url, bytes: 100, contentLength: 100 });
      }
      return { path: x.path };
    },
    addListener: async (e, c) => {
      ecouteur = c;
      journal.push({ addListener: e });
      return {
        remove: async () => {
          journal.push({ remove: true });
          ecouteur = null;
        },
      };
    },
  };
  return { plugin, journal };
}

/**
 * Horloge pilotée par le test : `avance(ms)` fait s'écouler le temps SANS
 * attendre, pour vérifier le délai de garde en quelques microsecondes.
 */
function horlogeFactice(depart = 0) {
  let t = depart;
  return {
    maintenant: () => t,
    avance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * Minuterie pilotée par le test : `planifier` capture la fonction de
 * surveillance, `battement()` la déclenche puis laisse la surveillance async
 * se terminer (une macrotâche suffit : `stat` est le seul `await`).
 */
function minuteurFactice() {
  let cb: (() => void) | null = null;
  let arrete = false;
  return {
    planifier: (f: () => void) => {
      cb = f;
      return () => {
        arrete = true;
        cb = null;
      };
    },
    battement: async () => {
      cb?.();
      await new Promise((r) => setTimeout(r, 0));
    },
    get arrete() {
      return arrete;
    },
  };
}

test("cheminModele renvoie le NOM DE FICHIER SEUL, et cheminRelatif le situe sous Documents", () => {
  assert.equal(cheminModele("coder05"), "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf");
  // « DATA » = getFilesDir() ; le sous-dossier « Documents » est la 2e entrée de
  // getModelSearchPaths() du plugin — celle qu'on vise.
  assert.equal(cheminRelatif("coder05"), "Documents/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf");
});

test("un modèle déjà présent et plausible n'est PAS re-téléchargé", async () => {
  const { plugin, journal } = pluginFactice({ tailles: [TAILLE_05] });
  const phases: ProgresChargement[] = [];
  const res = await telechargerModele("coder05", (p) => phases.push(p), plugin);

  assert.equal(res, "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf");
  assert.equal(journal.filter((j) => "downloadFile" in j).length, 0, "aucun téléchargement");
  assert.equal(journal.filter((j) => "mkdir" in j).length, 0, "aucun dossier à créer");
  assert.equal(phases.at(-1)?.phase, "pret");
});

test("un fichier absent est créé dans DATA/Documents et téléchargé avec progression", async () => {
  const modele = modeleGguf("coder05");
  const { plugin, journal } = pluginFactice({ tailles: [null, modele.octets] });
  const phases: ProgresChargement[] = [];
  const res = await telechargerModele("coder05", (p) => phases.push(p), plugin);

  assert.equal(res, modele.fichier);

  const mk = journal.find((j) => "mkdir" in j)?.mkdir as Record<string, unknown>;
  assert.equal(mk.path, "Documents", "le sous-dossier que le plugin visite");
  assert.equal(mk.directory, "DATA", "Directory.Data → getFilesDir()");
  assert.equal(mk.recursive, true);

  const dl = journal.find((j) => "downloadFile" in j)?.downloadFile as Record<string, unknown>;
  assert.equal(dl.url, modele.url);
  assert.equal(dl.path, "Documents/" + modele.fichier);
  assert.equal(dl.directory, "DATA");
  assert.equal(dl.progress, true, "la progression est demandée au plugin");

  // Deux vérifications de taille : avant (absent) et après (doit coller).
  assert.equal(journal.filter((j) => "stat" in j).length, 2);
  // Le pourcentage réel remonte (50 %), et l'évènement d'un AUTRE fichier est ignoré.
  assert.ok(
    phases.some((p) => p.phase === "telechargement" && p.pct === 50),
    "progression réelle 50 %",
  );
  assert.ok(
    !phases.some((p) => p.phase === "telechargement" && p.pct === 1),
    "la progression d'un autre fichier est ignorée",
  );
  assert.equal(phases.at(-1)?.phase, "pret");
  assert.ok(journal.some((j) => j.remove === true), "l'écouteur de progression est retiré");
});

test("un fichier tronqué fait ÉCHOUER la livraison, avec un message clair", async () => {
  const { plugin } = pluginFactice({ tailles: [null, 1234] });
  await assert.rejects(
    () => telechargerModele("coder05", undefined, plugin),
    /incomplet|corrompu/i,
    "une taille incohérente n'est jamais acceptée en silence",
  );
});

test("un fichier absent après téléchargement est rapporté, pas avalé", async () => {
  const { plugin } = pluginFactice({ tailles: [null, null] });
  await assert.rejects(
    () => telechargerModele("coder05", undefined, plugin),
    /introuvable après le téléchargement/i,
  );
});

test("un échec de téléchargement est traduit en conseil actionnable", async () => {
  const { plugin } = pluginFactice({ tailles: [null, null], echecTelechargement: "HTTP 404" });
  await assert.rejects(
    () => telechargerModele("coder05", undefined, plugin),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /Internet|connexion/i, "on dit de vérifier la connexion");
      assert.match(m, /espace libre|Go/i, "on dit d'où vient la place nécessaire");
      return true;
    },
  );
});

test("taillePlausible refuse 0, un négatif, NaN et un mauvais fichier", () => {
  assert.equal(taillePlausible(TAILLE_05, TAILLE_05), true);
  assert.equal(taillePlausible(TAILLE_05 * 0.99, TAILLE_05), true, "±2 % toléré");
  assert.equal(taillePlausible(TAILLE_05 * 1.01, TAILLE_05), true);
  assert.equal(taillePlausible(1000, TAILLE_05), false, "fichier d'une autre taille");
  assert.equal(taillePlausible(0, TAILLE_05), false);
  assert.equal(taillePlausible(-1, TAILLE_05), false);
  assert.equal(taillePlausible(Number.NaN, TAILLE_05), false);
});

test("l'erreur brute du moteur natif devient un message actionnable", () => {
  const traduit = messageErreurActionnable("Failed to initialize native context", "coder05");
  assert.match(traduit, /relance le téléchargement/i, "on dit quoi faire");
  assert.ok(!/Failed to initialize/i.test(traduit), "aucun code brut ne reste visible");
  // Une erreur déjà actionnable passe inchangée (pas de double emballage).
  assert.equal(messageErreurActionnable("le fichier est introuvable"), "le fichier est introuvable");
});

/**
 * LE QUANT DU 30B — 8,005 Go au lieu de 8,914 Go.
 *
 * Protégé ici parce que c'est la LIVRAISON qui décide de ce qui est chargé : le
 * téléphone garde le fichier d'un lancement à l'autre, et un ancien quant de
 * 8,914 Go ne doit pas passer pour le nouveau (il déborde des 12 Go une fois
 * comptés la KV, les buffers et l'OS). La tolérance de `taillePlausible` (±2 %)
 * est ce qui fait la différence : 0,9 Go d'écart, c'est un autre fichier.
 */
test("le 30B-A3B livré est bien le UD-TQ1_0 du Hub (8 005 213 344 octets)", () => {
  const modele = modeleGguf("coder3b");
  assert.equal(modele.fichier, "Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf");
  assert.equal(modele.octets, 8_005_213_344);
  assert.equal(modele.tailleGo, 8.005);
  assert.ok(modele.url.endsWith(modele.fichier));
  assert.ok(!modele.fichier.includes("IQ1_S"), "le quant trop gros pour la RAM est retiré");
  assert.equal(
    cheminRelatif("coder3b"),
    "Documents/Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf",
    "le fichier va dans le dossier que le plugin natif visite",
  );
});

test("l'ancien quant de 8,914 Go n'est PAS pris pour le nouveau : il est re-téléchargé", async () => {
  const modele = modeleGguf("coder3b");
  const ancien = 8_914_328_736; // UD-IQ1_S, l'ancien choix
  assert.equal(
    taillePlausible(ancien, modele.octets),
    false,
    "0,9 Go d'écart : c'est un autre fichier, pas le même",
  );

  // Fichier de l'ancien quant déjà sur l'appareil, puis le bon après
  // téléchargement : la livraison doit télécharger, et finir sur le bon fichier.
  const { plugin, journal } = pluginFactice({ tailles: [ancien, modele.octets] });
  const res = await telechargerModele("coder3b", undefined, plugin);
  assert.equal(res, modele.fichier);
  const dl = journal.find((j) => "downloadFile" in j)?.downloadFile as Record<string, unknown>;
  assert.equal(dl.path, "Documents/" + modele.fichier, "le bon fichier est téléchargé");
  assert.equal(dl.url, modele.url);
});

test("un 30B tronqué (téléchargement interrompu) est refusé, pas chargé", async () => {
  const modele = modeleGguf("coder3b");
  // 8 Go sur une connexion mobile, ça s'interrompt : un fichier de 4 Go ne doit
  // pas passer pour un modèle prêt (symptôme réel : « Failed to initialize
  // native context »).
  const { plugin } = pluginFactice({ tailles: [null, 4_000_000_000] });
  await assert.rejects(
    () => telechargerModele("coder3b", undefined, plugin),
    /incomplet|corrompu/i,
    `un fichier de 4 Go ne vaut pas ${modele.octets} octets`,
  );
});

test("changer de modèle ne réutilise pas le fichier d'un autre", async () => {
  // Trois fichiers, trois tailles : un 0,5B présent sur l'appareil ne doit pas
  // faire croire que le 30B est là. C'est le même garde-fou que pour le quant,
  // appliqué au choix de modèle.
  const fichiers = MODELES_GGUF.map((m) => m.fichier);
  assert.equal(new Set(fichiers).size, fichiers.length, "un fichier distinct par modèle");
  const { plugin, journal } = pluginFactice({
    tailles: [modeleGguf("coder05").octets, modeleGguf("coder3b").octets],
  });
  await telechargerModele("coder3b", undefined, plugin);
  const dl = journal.find((j) => "downloadFile" in j)?.downloadFile as Record<string, unknown>;
  assert.ok(
    String(dl.path).endsWith("Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf"),
    "c'est bien le 30B qui est livré",
  );
});

/* ===================================================================== */
/* PROGRESSION VISIBLE — le défaut signalé : un écran figé, sans chiffre. */
/* ===================================================================== */

test("la progression remonte les OCTETS reçus et le TOTAL, pas seulement un pourcentage", async () => {
  // Sans ça, l'interface n'a rien à afficher : le plugin donne `bytes` et
  // `contentLength` (ProgressStatus), jamais le pourcentage, et il faut bien
  // que les OCTETS remontent jusqu'à l'écran (« 430 Mo / 986 Mo »).
  const modele = modeleGguf("coder05");
  const { plugin } = pluginFactice({ tailles: [null, modele.octets] });
  const phases: ProgresChargement[] = [];
  await telechargerModele("coder05", (p) => phases.push(p), plugin);

  const enCours = phases.filter((p) => p.phase === "telechargement");
  assert.ok(enCours.length >= 2, "au moins le départ et la progression");
  assert.equal(enCours[0].octetsRecus, 0, "on part de zéro, sans mentir");
  assert.equal(enCours[0].octetsTotal, modele.octets, "total connu dès le départ");
  const dernier = enCours.at(-1)!;
  assert.equal(dernier.octetsRecus, 100, "les octets réels de l'évènement");
  assert.equal(dernier.octetsTotal, 100, "la taille annoncée par l'évènement");

  const pret = phases.at(-1)!;
  assert.equal(pret.phase, "pret");
  assert.equal(pret.octetsRecus, modele.octets);
  assert.equal(pret.octetsTotal, modele.octets);
});

test("les tailles s'écrivent comme l'interface les affiche (« 430 Mo / 986 Mo »)", () => {
  assert.equal(tailleLisible(430 * 1e6), "430 Mo");
  assert.equal(tailleLisible(986_048_800), "986 Mo");
  assert.equal(tailleLisible(modeleGguf("coder05").octets), "398 Mo");
  assert.equal(tailleLisible(8_005_213_344), "8,01 Go");
});

test("le dossier parent est créé AVANT le téléchargement, jamais après", async () => {
  // `getFileObject` du plugin ne crée pas les dossiers parents et `downloadFile`
  // ignore `recursive` : ouvrir le fichier avant le mkdir, c'est
  // « No such file or directory » après avoir peut-être déjà consommé du réseau.
  const modele = modeleGguf("coder05");
  const { plugin, journal } = pluginFactice({ tailles: [null, modele.octets] });
  const phases: ProgresChargement[] = [];
  await telechargerModele("coder05", (p) => phases.push(p), plugin);
  const iMkdir = journal.findIndex((j) => "mkdir" in j);
  const iDl = journal.findIndex((j) => "downloadFile" in j);
  assert.ok(iMkdir >= 0, "le mkdir a bien eu lieu");
  assert.ok(iDl >= 0, "le téléchargement a bien eu lieu");
  assert.ok(iMkdir < iDl, "mkdir(« Documents ») précède downloadFile");
  assert.equal(phases.at(-1)?.phase, "pret");
});

/* ===================================================================== */
/* DÉLAI DE GARDE — 60 s sans octet nouveau : on le DIT, jamais un écran  */
/* mort. C'est le même défaut qui avait été corrigé côté navigateur.      */
/* ===================================================================== */

test("le garde est PUR : il se déclenche sur l'absence d'octet NOUVEAU, à 60 s", () => {
  assert.equal(DELAI_GARDE_MS, 60_000, "60 s : le délai annoncé à l'utilisateur");
  assert.equal(gardeDepassee(0, 59_999, DELAI_GARDE_MS), false, "59,999 s : on attend encore");
  assert.equal(gardeDepassee(0, 60_000, DELAI_GARDE_MS), true, "60 s : on le dit");
  assert.equal(gardeDepassee(0, 61_000, DELAI_GARDE_MS), true);
});

test("le message du garde est noir sur blanc, chiffré, et dit comment reprendre", () => {
  const m = messageGarde(60, modeleGguf("coder05"), 100_000_000);
  assert.match(m, /ne progresse plus depuis 60 s/);
  assert.match(m, /100 Mo/, "les octets reçus, pour situer");
  assert.match(m, /398 Mo/, "ce qui était attendu");
  assert.match(m, /Wi-Fi|connexion/i, "quoi vérifier");
  assert.match(m, /relance|reprendre/i, "comment reprendre");
});

test("un téléchargement qui cale est abandonné à 60 s, avec le message exact", async () => {
  const { plugin, journal } = pluginFactice({ tailles: [null], telechargementBloque: true });
  const clk = horlogeFactice();
  const minuteur = minuteurFactice();
  const phases: ProgresChargement[] = [];

  const livraison = telechargerModele("coder05", (p) => phases.push(p), plugin, {
    maintenant: clk.maintenant,
    planifier: minuteur.planifier,
  });
  // Laisse la livraison atteindre la mise sous surveillance (les `await` du
  // mkdir et de addListener) avant de faire avancer l'horloge.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(phases.length > 0, "l'interface a déjà de quoi afficher (0 %, 0 Mo)");

  // 59 s sans octet : on ne dit RIEN encore (une connexion lente est permise).
  clk.avance(59_000);
  await minuteur.battement();
  const etat = await Promise.race([
    livraison.then(() => "finie").catch(() => "erreur"),
    new Promise((r) => setTimeout(() => r("en attente"), 5)),
  ]);
  assert.equal(etat, "en attente", "59 s : le téléchargement n'est pas encore coupé");

  // La 60e seconde : là, on le dit.
  clk.avance(1_000);
  await minuteur.battement();

  await assert.rejects(livraison, (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    assert.match(m, /le téléchargement ne progresse plus depuis 60 s/, "la phrase exacte");
    assert.match(m, /Wi-Fi|connexion/i, "quoi vérifier");
    assert.match(m, /relance/i, "la reprise est proposée");
    return true;
  });

  // Le partiel est effacé : la reprise ne repart pas d'un fichier douteux.
  const del = journal.find((j) => "deleteFile" in j)?.deleteFile as Record<string, unknown>;
  assert.equal(del.path, "Documents/" + modeleGguf("coder05").fichier);
  assert.equal(del.directory, "DATA");
  assert.ok(journal.some((j) => j.remove === true), "l'écouteur est retiré même en échec");
  assert.equal(minuteur.arrete, true, "la surveillance est arrêtée : plus de minuterie qui fuit");
});

test("une progression LENTE mais réelle ne déclenche PAS le garde, et s'affiche sans évènement", async () => {
  // Deux choses d'un coup :
  //  - le fichier grossit SANS qu'aucun évènement « progress » ne soit émis
  //    (downloadFile ne rend pas la main) : la surveillance du disque remonte
  //    quand même les octets — c'est ce qui rend la progression visible ;
  //  - 250 s s'écoulent, mais des octets nouveaux toutes les 50 s : le garde ne
  //    coupe pas un vrai téléchargement (il juge sur les octets, pas la durée).
  const { plugin } = pluginFactice({
    tailles: [null, 10_000_000, 20_000_000, 30_000_000, 40_000_000],
    telechargementBloque: true,
  });
  const clk = horlogeFactice();
  const minuteur = minuteurFactice();
  const phases: ProgresChargement[] = [];

  void telechargerModele("coder05", (p) => phases.push(p), plugin, {
    maintenant: clk.maintenant,
    planifier: minuteur.planifier,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 0));

  for (let i = 0; i < 5; i += 1) {
    clk.avance(50_000);
    await minuteur.battement();
  }

  assert.equal(minuteur.arrete, false, "le garde n'a pas coupé un vrai téléchargement");
  assert.ok(
    phases.some((p) => p.octetsRecus === 40_000_000),
    "l'octet courant est remonté même sans évènement du plugin",
  );
});

/* ===================================================================== */
/* ÉCHECS : deux causes, deux messages — jamais un code brut.            */
/* ===================================================================== */

test("échec réseau et échec de stockage mènent à deux conseils DIFFÉRENTS", async () => {
  const reseau = pluginFactice({
    tailles: [null, null],
    echecTelechargement: 'Unable to resolve host "huggingface.co": No address associated',
  });
  await assert.rejects(
    () => telechargerModele("coder05", undefined, reseau.plugin),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /connexion|Wi-Fi/i);
      assert.ok(!/espace libre|stockage/i.test(m), "on ne parle pas de place pour un souci réseau");
      return true;
    },
  );

  const espace = pluginFactice({
    tailles: [null, null],
    echecTelechargement: "ENOSPC: No space left on device",
  });
  await assert.rejects(
    () => telechargerModele("coder05", undefined, espace.plugin),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /espace libre|place/i, "on nomme le vrai problème : la place");
      assert.ok(!/Wi-Fi/i.test(m), "on n'accuse pas le réseau à tort");
      return true;
    },
  );
});

test("messageEchec nomme la cause, et couvre une erreur inattendue", () => {
  const modele = modeleGguf("coder05");
  assert.match(messageEchec(modele, "ENOSPC"), /espace libre/i);
  assert.match(messageEchec(modele, "ConnectException: failed to connect"), /connexion/i);
  const inconnu = messageEchec(modele, "HTTP 404");
  assert.match(inconnu, /Internet/i);
  assert.match(inconnu, /398 Mo/, "la taille nécessaire est dite");
  assert.match(inconnu, /relance/i);
});

