/**
 * Tests du moteur natif — sans Android et sans llama.cpp.
 *
 * Ce qui est protégé ici, parce que c'est ce qui a coûté cher en vrai :
 *  - le streaming remonte bien jeton par jeton (sinon pas d'effet de frappe) ;
 *  - la vitesse affichée est celle MESURÉE par llama.cpp (timings), jamais une
 *    estimation fabriquée à partir d'une longueur de texte ;
 *  - le déport GPU est demandé explicitement : c'est le seul réglage qui change
 *    l'ordre de grandeur de la vitesse ;
 *  - libérer l'ancien modèle avant d'en charger un autre (sinon la RAM explose
 *    sur un téléphone) ;
 *  - le mode « asset » : un GGUF embarqué dans l'appli se désigne par son nom de
 *    fichier seul, avec `is_model_asset`. Un chemin complet y serait faux.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { creerMoteurNatif, modeleGguf, MODELES_GGUF, type PluginLlama } from "./moteurNatif.ts";

function pluginFactice(journal: Record<string, unknown>[], reponse?: { text?: string; vitesses?: number }) {
  const plugin: PluginLlama = {
    initLlama: async (p) => {
      journal.push(p);
      return { id: "contexte" };
    },
    completion: async (p, cb) => {
      journal.push(p);
      for (const t of ["Bon", "jour"]) cb?.({ token: t });
      return { text: reponse?.text ?? "Bonjour", timings: { predicted_per_second: reponse?.vitesses ?? 17.5 } };
    },
    releaseAllLlama: async () => {
      journal.push({ libere: true });
    },
  };
  return async () => plugin;
}

const base = {
  cheminModele: (m: { fichier: string }) => `/data/models/${m.fichier}`,
  nbCoeurs: () => 8,
};

test("le déport GPU est demandé et le contexte est dimensionné", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder15");
  const init = journal[0];
  assert.equal(init.n_gpu_layers, 99, "tout déporter sur le GPU");
  assert.equal(init.n_ctx, 4096, "4096 : la boucle d'agent a besoin de place");
  assert.equal(init.n_batch, 512, "lot de pré-remplissage");
  assert.equal(init.n_ubatch, 512, "micro-lot aligné sur le lot");
  assert.equal(init.n_threads, 7, "cœurs moins un");
  assert.ok(String(init.model).endsWith("Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf"));
  assert.equal(m.pret(), true);
});

test("n_ctx et les lots de pré-remplissage sont configurables", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({
    ...base,
    nCtx: 8192,
    nBatch: 1024,
    nUbatch: 256,
    chargerPlugin: pluginFactice(journal),
  });
  await m.charger("coder15");
  assert.equal(journal[0].n_ctx, 8192);
  assert.equal(journal[0].n_batch, 1024);
  assert.equal(journal[0].n_ubatch, 256);
});

test("le mode asset passe is_model_asset et le NOM DE FICHIER seul", async () => {
  // Un GGUF embarqué dans les ressources de l'appli n'a pas de chemin : llama.cpp
  // le résout par son nom, à condition de le lui dire avec is_model_asset.
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({
    ...base,
    asset: true,
    cheminModele: (mod) => mod.fichier,
    chargerPlugin: pluginFactice(journal),
  });
  await m.charger("coder05");
  assert.equal(journal[0].is_model_asset, true, "le drapeau d'asset est transmis");
  assert.equal(
    journal[0].model,
    "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
    "le nom de fichier seul, sans dossier",
  );
});

test("sans asset, aucun is_model_asset (comportement d'origine préservé)", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder05");
  assert.ok(!("is_model_asset" in journal[0]), "le drapeau ne doit pas apparaître");
  assert.ok(String(journal[0].model).startsWith("/data/models/"), "on passe bien un chemin");
});

test("les jetons arrivent un par un et la vitesse vient de llama.cpp", async () => {
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice([], { text: "Bonjour", vitesses: 21.3 }) });
  await m.charger("coder15");
  const vus: string[] = [];
  let vitesse: number | null = null;
  const texte = await m.generer({
    system: "test",
    history: [{ role: "user", content: "salut" }],
    onToken: (t) => vus.push(t),
    onVitesse: (v) => {
      vitesse = v;
    },
  });
  assert.deepEqual(vus, ["Bon", "jour"], "streaming jeton par jeton");
  assert.equal(texte, "Bonjour");
  assert.equal(vitesse, 21.3, "la vitesse affichée est la mesure, pas une estimation");
  assert.equal(m.derniereVitesse(), 21.3);
});

test("générer sans modèle chargé échoue clairement", async () => {
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice([]) });
  await assert.rejects(() => m.generer({ system: "s", history: [] }), /aucun modèle natif chargé/);
});

test("changer de modèle libère l'ancien avant de charger le nouveau", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder05");
  await m.charger("coder3b");
  assert.equal(journal.filter((j) => j.libere).length, 1, "un seul relâchement");
  assert.ok(String(journal[journal.length - 1].model).includes("30B-A3B"));
});

test("recharger le même modèle ne relance pas l'initialisation", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder15");
  await m.charger("coder15");
  assert.equal(journal.filter((j) => j.n_ctx).length, 1);
});

test("le 30B-A3B est bien le pari à experts : gros fichier, peu lu par jeton", () => {
  const gros = MODELES_GGUF.find((m) => m.court.includes("30B"));
  assert.ok(gros, "présent dans la liste");
  assert.ok(gros.tailleGo > 4, "fichier lourd");
  assert.ok(gros.lectureGoParJeton < 2, "mais peu d'octets lus par jeton");
  // Et la fonction de résolution ne doit jamais renvoyer un modèle absent.
  assert.ok(modeleGguf("coder3b"));
});

test("le 30B-A3B pointe sur le quant IQ1_S réel du dépôt Hub", () => {
  const gros = modeleGguf("coder3b");
  // Nom exact vérifié sur l'API du Hub ; taille réelle 8 914 328 736 octets.
  assert.equal(gros.fichier, "Qwen3-Coder-30B-A3B-Instruct-UD-IQ1_S.gguf");
  assert.equal(gros.tailleGo, 8.9);
  assert.ok(!gros.fichier.includes("TQ1_0"), "l'ancien quant est remplacé");
  assert.ok(gros.nom.includes("IQ1_S"));
});

test("les contraintes de sortie (schéma JSON / grammaire) atteignent llama.cpp", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder15");
  await m.generer({ system: "s", history: [], jsonSchema: '{"type":"object"}' });
  await m.generer({ system: "s", history: [], grammar: 'root ::= "a"' });
  const comps = journal.filter((j) => "prompt" in j);
  assert.equal(comps[0].json_schema, '{"type":"object"}', "le schéma est transmis");
  assert.ok(!("grammar" in comps[0]), "aucune grammaire quand seul le schéma est fourni");
  assert.equal(comps[1].grammar, 'root ::= "a"', "la grammaire est transmise");
  assert.ok(!("json_schema" in comps[1]), "pas de schéma quand seule la grammaire est fournie");
});

/** Plugin qui expose en plus les méthodes de session (cache d'état du prompt). */
function pluginAvecSession(
  journal: Record<string, unknown>[],
  opts?: { saveEchoue?: boolean },
): () => Promise<PluginLlama> {
  const plugin: PluginLlama = {
    initLlama: async (p) => {
      journal.push(p);
      return { id: "contexte" };
    },
    completion: async (p, cb) => {
      journal.push(p);
      for (const t of ["o", "k"]) cb?.({ token: t });
      return { text: "ok", timings: { predicted_per_second: 10 } };
    },
    saveSession: async (f) => {
      journal.push({ saveSession: f });
      if (opts?.saveEchoue) throw new Error("disque plein");
      return 1;
    },
    loadSession: async (f) => {
      journal.push({ loadSession: f });
      return { tokens_loaded: 1, prompt: "" };
    },
  };
  return async () => plugin;
}

test("le cache d'état du prompt est DÉSACTIVÉ par défaut", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginAvecSession(journal) });
  await m.charger("coder15");
  await m.generer({ system: "s", history: [] });
  await m.generer({ system: "s", history: [] });
  const sessions = journal.filter((j) => j.saveSession || j.loadSession);
  assert.equal(sessions.length, 0, "aucun appel de session sans cheminCache");
  assert.equal(m.cacheSauve(), false);
});

test("avec un chemin, l'état est sauvé une fois puis rechargé aux pas suivants", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({
    ...base,
    cheminCache: "/data/studio/cache.kv",
    chargerPlugin: pluginAvecSession(journal),
  });
  await m.charger("coder15");
  await m.generer({ system: "s", history: [] });
  assert.equal(m.cacheSauve(), true, "sauvé dès le premier pas");
  await m.generer({ system: "s", history: [] });

  const sauv = journal.filter((j) => j.saveSession);
  const rech = journal.filter((j) => j.loadSession);
  assert.equal(sauv.length, 1, "sauvé une seule fois");
  assert.equal(sauv[0].saveSession, "/data/studio/cache.kv");
  assert.equal(rech.length, 1, "rechargé une fois au second pas");
  assert.equal(rech[0].loadSession, "/data/studio/cache.kv");
});

test("un échec du cache n'interrompt pas la génération", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({
    ...base,
    cheminCache: "/x",
    chargerPlugin: pluginAvecSession(journal, { saveEchoue: true }),
  });
  await m.charger("coder15");
  const texte = await m.generer({ system: "s", history: [] });
  assert.equal(texte, "ok", "la génération réussit malgré l'échec du cache");
  assert.equal(m.cacheSauve(), false);
  // Échec constaté : on ne retente pas à chaque pas.
  await m.generer({ system: "s", history: [] });
  assert.equal(journal.filter((j) => j.saveSession).length, 1, "une seule tentative");
  assert.equal(journal.filter((j) => j.loadSession).length, 0, "aucun rechargement inutile");
});

test("changer de modèle remet le cache à zéro", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({
    ...base,
    cheminCache: "/x",
    chargerPlugin: pluginAvecSession(journal),
  });
  await m.charger("coder15");
  await m.generer({ system: "s", history: [] });
  assert.equal(m.cacheSauve(), true);
  await m.charger("coder05");
  assert.equal(m.cacheSauve(), false, "le cache ne vaut que pour le contexte qui l'a produit");
});
