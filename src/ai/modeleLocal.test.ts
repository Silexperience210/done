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
  messageErreurActionnable,
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
 */
function pluginFactice(o: {
  tailles: (number | null)[];
  echecTelechargement?: string;
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
    downloadFile: async (x) => {
      journal.push({ downloadFile: x });
      if (o.echecTelechargement) throw new Error(o.echecTelechargement);
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

