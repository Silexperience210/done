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
 *    sur un téléphone).
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
  assert.equal(init.n_ctx, 2048);
  assert.equal(init.n_threads, 7, "cœurs moins un");
  assert.ok(String(init.model).endsWith("Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf"));
  assert.equal(m.pret(), true);
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
