/**
 * Tests de l'historique : enregistrement borné, tri, nom d'export, export natif
 * avec repli — le tout sur un stockage en mémoire et un plugin simulé.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  criteresLisibles,
  enregistrerApp,
  exporterHtml,
  listerApps,
  MAX_APPS,
  nomFichierExport,
  stockageMemoire,
  type AppEnregistree,
} from "./historique.ts";

function app(id: string, date: number, extra: Partial<AppEnregistree> = {}): AppEnregistree {
  return {
    id,
    date,
    titre: "Pong",
    question: "un pong",
    modele: "coder05",
    reglages: { nCtx: 4096, nBatch: 512, nThreads: 4 },
    html: "<!DOCTYPE html><html><body>pong</body></html>",
    versions: [{ pas: 2, html: "<html>v1</html>", tronque: true, jetons: 1500, date }],
    metriques: { tokParSeconde: 19.6, jetonsProduits: 1523, dureeMs: 80000, pasUtilises: 3, criteres: "1/2", conclu: false, tronque: true },
    ...extra,
  };
}

test("les apps sont listées des plus récentes aux plus anciennes, et la galerie est bornée", async () => {
  const s = stockageMemoire();
  for (let i = 0; i < MAX_APPS + 5; i++) await enregistrerApp(app(`a${i}`, 1000 + i), s);
  const toutes = await listerApps(s);
  assert.equal(toutes.length, MAX_APPS);
  assert.equal(toutes[0].id, `a${MAX_APPS + 4}`, "la plus récente d'abord");
  assert.ok(!toutes.some((a) => a.id === "a0"), "les plus anciennes sont effacées");
});

test("une version tronquée est conservée AVEC son verdict, jamais maquillée en finie", async () => {
  const s = stockageMemoire();
  await enregistrerApp(app("x", 1), s);
  const [a] = await listerApps(s);
  assert.equal(a.versions[0].tronque, true);
  assert.equal(a.metriques.tronque, true);
  assert.equal(a.metriques.conclu, false);
});

test("criteresLisibles : « ok/total » ou « — » sans contrat", () => {
  assert.equal(criteresLisibles(null), "—");
  assert.equal(criteresLisibles({ criteres: [], complet: false, conclu: false, pasUtilises: 1, plafond: 6, tronque: false, motif: null }), "—");
  const c = (etat: "ok" | "echec") => ({ n: 1, critere: { type: "app_sans_erreur" as const }, libelle: "", etat, preuve: null });
  assert.equal(criteresLisibles({ criteres: [c("ok"), c("echec"), c("ok")], complet: false, conclu: false, pasUtilises: 3, plafond: 6, tronque: false, motif: null }), "2/3");
});

test("nomFichierExport : titre nettoyé + horodatage, jamais vide", () => {
  const nom = nomFichierExport({ titre: "Mon Pong : édition « été » !", date: new Date(2026, 8, 12, 18, 5).getTime() });
  assert.equal(nom, "mon-pong-edition-ete-20260912-1805.html");
  assert.match(nomFichierExport({ titre: "???", date: 0 }), /^app-\d{8}-\d{4}\.html$/);
});

test("export natif : Download d'abord, Documents en repli, et l'erreur réelle si tout échoue", async () => {
  const a = app("e", new Date(2026, 8, 12, 9, 0).getTime());
  const ecrits: string[] = [];
  const chemin = await exporterHtml(a, {
    natif: true,
    ecrire: async (o) => {
      ecrits.push(`${o.directory}/${o.path}`);
      if (o.directory === "EXTERNAL_STORAGE") throw new Error("EACCES");
    },
  });
  assert.deepEqual(ecrits, ["EXTERNAL_STORAGE/Download/pong-20260912-0900.html", "DOCUMENTS/pong-20260912-0900.html"]);
  assert.equal(chemin, "/sdcard/Documents/pong-20260912-0900.html");
  await assert.rejects(
    exporterHtml(a, {
      natif: true,
      ecrire: async () => {
        throw new Error("disque plein");
      },
    }),
    /export impossible : \/sdcard\/Download\/pong-20260912-0900\.html → disque plein ; \/sdcard\/Documents/,
  );
});
