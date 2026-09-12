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
  chargerPuisTelecharger,
  cheminManuel,
  cheminModele,
  cheminRelatif,
  chercherModele,
  DELAI_GARDE_MS,
  DELAIS_HTTP,
  EMPLACEMENTS_MODELE,
  DOSSIER_PUBLIC,
  estMessageLivraison,
  gardeDepassee,
  messageEchec,
  messageErreurActionnable,
  messageGarde,
  messageLivraisonRatee,
  messageModeleIntrouvable,
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
  const modele = modeleGguf("coder05");
  const { plugin } = pluginFactice({ tailles: [null, null] });
  await assert.rejects(
    () => telechargerModele("coder05", undefined, plugin),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /introuvable après le téléchargement/i);
      // Un `downloadFile` qui RÉUSSIT sur un fichier absent est un échec
      // silencieux : on montre où on a cherché, et l'issue manuelle.
      assert.ok(m.includes("Documents/" + modele.fichier), "on dit où on a cherché");
      assert.ok(m.includes(modele.url), "et l'URL du téléchargement manuel");
      return true;
    },
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

test("l'erreur brute du moteur natif devient un message actionnable, chemin manuel compris", () => {
  const traduit = messageErreurActionnable("Failed to initialize native context", "coder05");
  // Ce qu'on doit POUVOIR FAIRE, sans dépendre de notre code de téléchargement :
  const modele = modeleGguf("coder05");
  assert.match(traduit, /Download/, "on nomme le dossier où poser le fichier");
  assert.ok(traduit.includes(modele.fichier), "le nom EXACT du fichier attendu est affiché");
  assert.ok(traduit.includes(modele.url), "l'URL directe est affichée, à ouvrir dans Chrome");
  assert.match(traduit, /relance/i, "on dit quoi faire");
  // ET l'erreur réelle reste visible : sans elle, impossible de savoir POURQUOI
  // le natif n'a pas ouvert le fichier. On ne l'avale plus.
  assert.ok(
    traduit.includes("Failed to initialize native context"),
    "l'erreur réelle du moteur est conservée",
  );
  // Une erreur déjà actionnable passe inchangée (pas de double emballage).
  assert.equal(messageErreurActionnable("le fichier est introuvable"), "le fichier est introuvable");
  // Nos propres diagnostics, même contenant l'erreur brute du moteur, ne sont PAS
  // retraduits : ce serait avaler l'URL et le nom de fichier qu'ils portent.
  const notre = messageLivraisonRatee("coder05", { erreurChargement: "Failed to initialize native context" });
  assert.equal(messageErreurActionnable(notre, "coder05"), notre);
  assert.equal(estMessageLivraison(notre), true);
  assert.equal(estMessageLivraison("Failed to initialize native context"), false);
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

test("des délais HTTP sont imposés au natif, sinon il attend indéfiniment", async () => {
  // `LegacyFilesystemImplementation.kt:92-93` lit ces deux options et
  // `HttpRequestHandler.java:112-113` ne les applique que si elles sont NON
  // NULLES. Absentes, `HttpURLConnection` garde son défaut (0 = pour toujours) :
  // un Wi-Fi qui tombe bloque le fil de téléchargement sans jamais rejeter, et
  // l'écran reste figé — exactement le symptôme rapporté.
  const modele = modeleGguf("coder05");
  const { plugin, journal } = pluginFactice({ tailles: [null, modele.octets] });
  await telechargerModele("coder05", undefined, plugin);
  const dl = journal.find((j) => "downloadFile" in j)?.downloadFile as Record<string, unknown>;
  assert.equal(dl.connectTimeout, DELAIS_HTTP.CONNEXION_MS, "délai de connexion transmis");
  assert.equal(dl.readTimeout, DELAIS_HTTP.LECTURE_MS, "délai de lecture transmis");
  assert.ok(
    DELAIS_HTTP.LECTURE_MS < DELAI_GARDE_MS,
    "le natif doit abandonner AVANT le garde JS : lui seul libère le socket et le fichier",
  );
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

/* ===================================================================== */
/* CHARGER D'ABORD — le téléchargement n'est plus un prérequis.          */
/*                                                                       */
/* C'est LE correctif : le plugin natif trouve le GGUF tout seul s'il est */
/* dans Download (LlamaCpp.java:1095, `getModelSearchPaths`). Télécharger */
/* avant de charger faisait d'un `downloadFile` cassé un blocage TOTAL.  */
/* ===================================================================== */

test("le modèle est CHARGÉ d'abord : trouvé sur le téléphone, aucune requête réseau", async () => {
  // Le cas de l'utilisateur qui a déposé le GGUF dans Download : le chargement
  // réussit du premier coup, et le téléchargement n'est JAMAIS appelé.
  const appels: string[] = [];
  const res = await chargerPuisTelecharger({
    id: "coder05",
    charger: async () => {
      appels.push("charger");
    },
    telecharger: async () => {
      appels.push("telecharger");
    },
  });

  assert.deepEqual(appels, ["charger"], "aucun téléchargement n'a été tenté");
  assert.equal(res.dejaLa, true);
  assert.equal(res.erreurChargement, null);
  assert.equal(res.erreurTelechargement, null);
});

test("chargement impossible → secours → rechargement, exactement dans cet ordre", async () => {
  const appels: string[] = [];
  let essais = 0;
  const res = await chargerPuisTelecharger({
    id: "coder05",
    charger: async () => {
      appels.push("charger");
      essais += 1;
      if (essais === 1) throw new Error("Failed to initialize native context");
    },
    telecharger: async () => {
      appels.push("telecharger");
    },
  });

  assert.deepEqual(appels, ["charger", "telecharger", "charger"]);
  assert.equal(res.dejaLa, false);
  assert.equal(res.erreurChargement, "Failed to initialize native context");
});

test("les deux échouent : l'erreur porte les DEUX erreurs RÉELLES et le chemin manuel", async () => {
  const modele = modeleGguf("coder05");
  await assert.rejects(
    () =>
      chargerPuisTelecharger({
        id: "coder05",
        charger: async () => {
          throw new Error("Failed to initialize native context");
        },
        telecharger: async () => {
          throw new Error("Error downloading file: java.io.FileNotFoundException");
        },
      }),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      // Rien n'est avalé : les deux erreurs réelles sont citées mot pour mot.
      assert.match(m, /Failed to initialize native context/, "l'erreur du chargement est citée");
      assert.match(m, /FileNotFoundException/, "l'erreur RÉELLE du téléchargement est citée");
      // Et l'issue qui ne dépend pas de l'appli est donnée en entier.
      assert.ok(m.includes(modele.fichier), "le nom EXACT du fichier attendu");
      assert.ok(m.includes(modele.url), "l'URL directe à ouvrir dans Chrome");
      assert.match(m, /dossier Download/i, "la consigne de dépôt");
      return true;
    },
  );
});

test("téléchargement réussi mais modèle toujours introuvable : on ne le cache pas", async () => {
  let essais = 0;
  await assert.rejects(
    () =>
      chargerPuisTelecharger({
        id: "coder05",
        charger: async () => {
          essais += 1;
          if (essais > 1) throw new Error("Failed to initialize native context");
          throw new Error("premier chargement : aucun fichier");
        },
        telecharger: async () => {},
      }),
    /reste introuvable pour le moteur : Failed to initialize native context/,
  );
});

test("le chemin manuel affiche le nom EXACT, l'URL et le dossier Download", () => {
  const modele = modeleGguf("coder05");
  const c = cheminManuel("coder05");
  assert.equal(c.fichier, modele.fichier, "le nom affiché = celui que le plugin cherchera");
  assert.equal(c.url, modele.url, "l'URL est celle du GGUF, pas une page intermédiaire");
  assert.equal(c.dossier, "Download");
  assert.equal(c.dossier, DOSSIER_PUBLIC);
  assert.equal(c.chemin, `/sdcard/Download/${modele.fichier}`);
  assert.equal(c.octets, modele.octets, "la taille exacte attendue");
});

test("le message « introuvable » est autosuffisant : nom, URL, dossier Download", () => {
  const modele = modeleGguf("coder3b");
  const m = messageModeleIntrouvable("coder3b");
  assert.ok(m.includes(modele.fichier), "le nom exact du fichier");
  assert.ok(m.includes(modele.url), "l'URL directe");
  assert.match(m, /dossier Download/i, "le dossier où le poser");
  assert.match(m, /8,01 Go/, "la taille à obtenir, en clair");
  // Chaque modèle a SON fichier et SON URL : aucune confusion possible.
  assert.notEqual(cheminManuel("coder3b").fichier, cheminManuel("coder05").fichier);
});

/* ===================================================================== */
/* ÉCHEC IMMÉDIAT ET SILENCIEUX — le cas rapporté : « ça ne démarre pas ». */
/* ===================================================================== */

test("un échec immédiat est DIT : erreur brute du plugin + zéro octet reçu", async () => {
  // Le scénario réel : `downloadFile` (déprécié en 8.1.3) rejette tout de suite,
  // sans jamais recevoir un octet. Le message doit citer l'erreur telle quelle ET
  // dire que l'appel n'a pas démarré — sinon on cherche du côté du réseau à tort.
  const { plugin } = pluginFactice({
    tailles: [null],
    echecTelechargement: "reject: no implementation found",
  });
  await assert.rejects(
    () => telechargerModele("coder05", undefined, plugin),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /no implementation found/, "l'erreur réelle du plugin est affichée");
      assert.match(m, /Aucun octet n'a été reçu/, "un non-démarrage est distingué d'un échec réseau");
      assert.match(m, /en \d+ ms/, "le délai de l'échec est donné");
      return true;
    },
  );
});


/* ------------------------------------------------------------------------- */
/* OÙ EST LE FICHIER — le diagnostic écrit dans la trace (voir journal.ts).   */
/* ------------------------------------------------------------------------- */

/**
 * Simulacre qui répond SELON LE CHEMIN demandé : c'est ce qui permet de
 * distinguer « présent ici », « absent là » et « refusé pour permission ».
 */
function pluginParChemin(reponses: Record<string, number | Error>): PluginFichiers {
  return {
    mkdir: async () => ({}),
    stat: async (x) => {
      const reponse = reponses[`${x.directory}:${x.path}`];
      if (reponse === undefined) {
        // Message RÉEL du plugin pour un fichier absent (FilesystemErrors.kt).
        throw new Error("'stat' failed because file does not exist. (OS-PLUG-FILE-0008)");
      }
      if (reponse instanceof Error) throw reponse;
      return { size: reponse };
    },
    deleteFile: async () => {},
    downloadFile: async () => ({}),
    addListener: async () => ({ remove: async () => {} }),
  };
}

test("chercherModele interroge les HUIT emplacements du moteur, dans SON ordre", async () => {
  // L'ordre et les chemins sont ceux de `LlamaCpp.getModelSearchPaths`
  // (LlamaCpp.java:1095-1122), pas une invention : le natif s'arrête au premier
  // fichier existant, donc savoir LEQUEL des huit il a pris est tout le
  // diagnostic.
  const fichier = modeleGguf("coder05").fichier;
  const etat = await chercherModele("coder05", pluginParChemin({}));
  assert.deepEqual(
    etat.emplacements.map((e) => `${e.directory}:${e.path}`),
    [
      `DATA:${fichier}`,
      `DATA:Documents/${fichier}`,
      `EXTERNAL:${fichier}`,
      `EXTERNAL:Documents/${fichier}`,
      `DOCUMENTS:${fichier}`,
      `EXTERNAL_STORAGE:Download/${fichier}`,
      `EXTERNAL_STORAGE:Downloads/${fichier}`,
      `EXTERNAL_STORAGE:Downloads/models/${fichier}`,
    ],
  );
  assert.equal(etat.trouves.length, 0, "aucun fichier trouvé : rien n'est inventé");
  assert.ok(
    etat.emplacements.every((e) => e.etat === "absent"),
    "« pas encore téléchargé » est un ÉTAT, pas une erreur",
  );
  assert.ok(
    etat.emplacements.every((e) => e.erreur === null),
    "et on n'affiche donc aucune erreur brute pour une simple absence",
  );
});

test("un fichier présent est rapporté avec sa TAILLE EXACTE ; un refus de permission n'est pas une absence", async () => {
  const fichier = modeleGguf("coder05").fichier;
  const etat = await chercherModele(
    "coder05",
    pluginParChemin({
      [`EXTERNAL_STORAGE:Download/${fichier}`]: TAILLE_05,
      // EACCES : le dossier existe mais l'appli n'a pas le droit d'y regarder.
      [`DOCUMENTS:${fichier}`]: new Error("EACCES (Permission denied)"),
    }),
  );
  assert.equal(etat.trouves.length, 1, "un seul fichier réellement là");
  assert.equal(etat.trouves[0].octets, TAILLE_05, "taille exacte, à comparer à celle attendue");
  assert.equal(etat.trouves[0].etat, "present");
  assert.equal(
    etat.trouves[0].chemin,
    `/sdcard/Download/${fichier}`,
    "le chemin est celui qu'on montrerait à l'utilisateur",
  );
  const refuse = etat.emplacements.find((e) => e.directory === "DOCUMENTS");
  assert.equal(refuse?.etat, "refuse", "un refus n'est PAS une absence : on ne comble pas ça en téléchargeant");
  assert.match(refuse?.erreur ?? "", /EACCES/, "l'erreur brute est conservée telle quelle");
  const absent = etat.emplacements.find((e) => e.directory === "DATA" && e.path === fichier);
  assert.equal(absent?.etat, "absent");
});

test("chercherModele ne lève JAMAIS : un plugin en panne est rapporté, jamais subi", async () => {
  // Un diagnostic qui échoue ne doit pas casser le chargement : c'est la
  // propriété la plus importante de cette fonction, avec « ne bloque rien ».
  const etat = await chercherModele(
    "coder05",
    pluginParChemin(
      Object.fromEntries(
        EMPLACEMENTS_MODELE.map((e) => [
          `${e.directory}:${e.prefixe}${modeleGguf("coder05").fichier}`,
          new Error("stockage non monté"),
        ]),
      ),
    ),
  );
  assert.equal(etat.trouves.length, 0);
  assert.equal(etat.emplacements.length, 8);
  assert.ok(
    etat.emplacements.every((e) => e.etat === "refuse"),
    "aucun emplacement ne répond : tout est « refusé », pas « absent »",
  );
});

test("sans plugin fichiers du tout, chercherModele rend un refus explicite au lieu de lever", async () => {
  const etat = await chercherModele("coder05", undefined);
  // En Node, `@capacitor/filesystem` se résout sur l'implémentation web : aucun
  // `stat` ne peut aboutir. Le résultat doit être lisible, pas une exception.
  assert.equal(etat.trouves.length, 0);
  assert.ok(etat.emplacements.length > 0);
  assert.ok(
    etat.emplacements.every((e) => e.etat === "refuse" && e.erreur !== null),
    "chaque emplacement porte la raison de son échec",
  );
});
