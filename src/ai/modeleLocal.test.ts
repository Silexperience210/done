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
  cheminCachePrompt,
  cheminModele,
  cheminNatifDepuisUri,
  cheminRelatif,
  messageErreurActionnable,
  taillePlausible,
  telechargerModele,
  type PluginFichiers,
  type ProgresFichier,
} from "./modeleLocal.ts";
import { modeleGguf } from "./moteurNatif.ts";
import type { ProgresChargement } from "./localModel.ts";

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
 * CACHE D'ÉTAT DU PROMPT — le chemin vient de @capacitor/filesystem.
 *
 * Protégé ici, parce que c'est un chemin qui part vers le natif :
 *  - l'URI `file://` que rend `getUri` est ramenée à un chemin de fichier NATIF
 *    (le plugin llama.cpp n'accepte QUE ça pour `saveSession`, qui ne retire pas
 *    le préfixe lui-même — vérifié dans dist/esm/index.js) ;
 *  - si le chemin est indisponible, le cache reste SANS EFFET (`undefined`), il
 *    ne fait jamais échouer une livraison de modèle.
 */
test("cheminNatifDepuisUri ramène une URI file:// à un chemin natif", () => {
  assert.equal(
    cheminNatifDepuisUri("file:///data/user/0/org.silexperience.studiolocal/files"),
    "/data/user/0/org.silexperience.studiolocal/files",
  );
  // Slash final retiré : pas de « // » avant le nom du fichier de cache.
  assert.equal(cheminNatifDepuisUri("file:///data/app/files/"), "/data/app/files");
  // URI encodée : décodée APRÈS retrait du préfixe (getUri rend la forme encodée).
  assert.equal(cheminNatifDepuisUri("file:///data/app/Mes%20documents"), "/data/app/Mes documents");
  // Chemin déjà natif : transmis tel quel, jamais « décodé » (un % y est littéral).
  assert.equal(cheminNatifDepuisUri("/data/app/Mes%20documents"), "/data/app/Mes%20documents");
});

test("cheminNatifDepuisUri refuse tout ce qui n'est pas exploitable", () => {
  assert.equal(cheminNatifDepuisUri(""), null);
  assert.equal(cheminNatifDepuisUri("   "), null);
  assert.equal(cheminNatifDepuisUri(undefined), null);
  assert.equal(cheminNatifDepuisUri(null), null);
  assert.equal(cheminNatifDepuisUri(42 as unknown as string), null);
});

test("cheminCachePrompt situe le cache à la racine de Directory.Data (getFilesDir)", async () => {
  const appels: Record<string, unknown>[] = [];
  const plugin = {
    getUri: async (o: { path: string; directory: string }) => {
      appels.push(o);
      return { uri: "file:///data/user/0/org.silexperience.studiolocal/files/" };
    },
  } as unknown as PluginFichiers;

  const chemin = await cheminCachePrompt(plugin);
  assert.equal(chemin, "/data/user/0/org.silexperience.studiolocal/files/studio-prompt-cache.kv");
  assert.deepEqual(appels, [{ path: "", directory: "DATA" }], "Directory.Data → getFilesDir()");
});

test("cheminCachePrompt DÉSACTIVE le cache si le chemin est indisponible", async () => {
  // Méthode absente (version de plugin sans getUri) : pas de cache, pas d'échec.
  const sansGetUri = {} as unknown as PluginFichiers;
  assert.equal(await cheminCachePrompt(sansGetUri), undefined);

  // Appel en erreur : avalé, cache désactivé.
  const enErreur = {
    getUri: async () => {
      throw new Error("permission refusée");
    },
  } as unknown as PluginFichiers;
  assert.equal(await cheminCachePrompt(enErreur), undefined);

  // URI vide / inexploitable : même verdict.
  const uriVide = {
    getUri: async () => ({ uri: "" }),
  } as unknown as PluginFichiers;
  assert.equal(await cheminCachePrompt(uriVide), undefined);
});
