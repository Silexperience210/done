/**
 * Vérification de la LIVRAISON AUTOMATIQUE (voir `telechargerModeleAutomatique`).
 *
 * POURQUOI CE TEST EXISTE : la livraison automatique est ce qui remplace un
 * contournement manuel (398 Mo téléchargés avec Chrome puis importés à la main).
 * Deux propriétés doivent tenir, et aucune ne se voit à l'œil nu :
 *   1. le téléchargeur de la WebView est essayé EN PREMIER — sinon on retombe
 *      silencieusement sur le `downloadFile` cassé de l'appareil visé ;
 *   2. s'il échoue, on essayer quand même l'ancien — un échec du fetch (CORS,
 *      réseau filtré) ne doit pas supprimer la fonctionnalité.
 * Et l'avancement remonté à l'interface doit porter les OCTETS, sinon l'écran
 * affiche un pourcentage sans dire où on en est.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { telechargerModeleAutomatique } from "./modeleLocal.ts";
import { modeleGguf } from "./moteurNatif.ts";
import type { ProgresChargement } from "./types.ts";

test("le téléchargeur de la WebView est essayé en PREMIER, et l'avancement porte les octets", async () => {
  const modele = modeleGguf("coder05");
  const appels: string[] = [];
  const progres: ProgresChargement[] = [];

  await telechargerModeleAutomatique(
    "coder05",
    (p) => progres.push(p),
    {
      parFetch: async (_id, cb) => {
        appels.push("fetch");
        cb?.({ octetsRecus: 100_000_000, octetsTotal: modele.octets, morceaux: 48, repris: 0 });
        cb?.({ octetsRecus: modele.octets, octetsTotal: modele.octets, morceaux: 191, repris: 0 });
        return { octets: modele.octets, chemin: `Documents/${modele.fichier}`, essais: 1 };
      },
      parPlugin: async () => {
        appels.push("plugin");
        return "Documents/plugin";
      },
    },
  );

  assert.deepEqual(appels, ["fetch"], "le plugin n'est PAS appelé quand le fetch réussit");
  assert.equal(progres.length, 2);
  const dernier = progres.at(-1);
  assert.equal(dernier?.phase, "telechargement");
  assert.equal(dernier?.pct, 100);
  assert.equal(dernier?.octetsRecus, modele.octets, "les octets sont remontés à l'interface");
  assert.equal(dernier?.octetsTotal, modele.octets);
  assert.match(dernier?.fichier ?? "", /0\.5B Q4/, "le libellé nomme le modèle");
  assert.ok((dernier?.ecouleMs ?? -1) >= 0, "la durée écoulée est fournie");
});

test("si le fetch échoue, l'ancien téléchargeur est essayé (le repli tient)", async () => {
  const appels: string[] = [];
  await telechargerModeleAutomatique("coder05", undefined, {
    parFetch: async () => {
      appels.push("fetch");
      throw new Error("WebView sans ReadableStream");
    },
    parPlugin: async () => {
      appels.push("plugin");
      return "Documents/plugin";
    },
  });
  assert.deepEqual(appels, ["fetch", "plugin"], "les deux voies sont essayées, dans cet ordre");
});

test("si le REPLI échoue lui aussi, l'erreur du repli remonte (elle est réelle)", async () => {
  await assert.rejects(
    () =>
      telechargerModeleAutomatique("coder05", undefined, {
        parFetch: async () => {
          throw new Error("fetch: Failed to fetch");
        },
        parPlugin: async () => {
          throw new Error("Error downloading file: java.io.FileNotFoundException");
        },
      }),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /FileNotFoundException/, "l'erreur RÉELLE du repli est citée");
      return true;
    },
  );
});
