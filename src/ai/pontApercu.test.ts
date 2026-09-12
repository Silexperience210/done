/**
 * Tests du pont aperçu ↔ appli : le script injecté est du JavaScript VALIDE (on
 * l'analyse avec `new Function`, sans l'exécuter), il est premier dans le
 * document, et les messages sont lus strictement (une forme inattendue est
 * ignorée, jamais complétée).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { injecterPont, ligneConsole, lireMessageApercu, scriptPont, SOURCE_PONT } from "./pontApercu.ts";

test("le script du pont est du JavaScript syntaxiquement valide", () => {
  const script = scriptPont(3);
  const corps = script.replace(/^<script>/, "").replace(/<\/script>$/, "");
  assert.doesNotThrow(() => new Function(corps), "analyse sans exécution");
  assert.ok(corps.includes("var V=3,"), "la version est inscrite dans le script");
  assert.ok(corps.includes("addEventListener('error'"));
  assert.ok(corps.includes("'unhandledrejection'"));
  assert.ok(corps.includes("['error','warn','log']"), "console.error/warn/log sont enveloppés");
  assert.ok(corps.includes("addEventListener('load'"), "le signal de fin de chargement");
  assert.ok(corps.includes("'studio:eval'"), "l'évaluation à la demande du parent");
});

test("le pont est injecté EN PREMIER : après <head>, sinon après <html>, sinon en tête", () => {
  const avecHead = injecterPont('<!DOCTYPE html><html><head><meta charset="utf-8"><script>boom()</script></head><body></body></html>', 1);
  assert.ok(avecHead.indexOf("<script>(function(){") < avecHead.indexOf("<script>boom()"), "avant le script de l'app");
  assert.match(avecHead, /<head><script>\(function\(\)\{/);
  const sansHead = injecterPont("<html><body>x</body></html>", 2);
  assert.match(sansHead, /^<html><script>/);
  const fragment = injecterPont("<div>x</div>", 3);
  assert.match(fragment, /^<script>/);
});

test("lireMessageApercu : strict sur la forme, ignore tout ce qui n'est pas du pont", () => {
  assert.equal(lireMessageApercu(null), null);
  assert.equal(lireMessageApercu({ type: "console" }), null, "sans source : pas à nous");
  assert.equal(lireMessageApercu({ source: SOURCE_PONT, type: "console" }), null, "sans version : refusé");
  assert.equal(lireMessageApercu({ source: SOURCE_PONT, version: 1, type: "console", niveau: "debug", message: "x" }), null);
  const c = lireMessageApercu({ source: SOURCE_PONT, version: 4, type: "console", niveau: "error", message: "x is not defined", ligne: 12, colonne: 5, ts: 1000 });
  assert.deepEqual(c, {
    type: "console",
    version: 4,
    entree: { niveau: "error", message: "x is not defined", ligne: 12, colonne: 5, ts: 1000, version: 4 },
  });
  const sansPosition = lireMessageApercu({ source: SOURCE_PONT, version: 4, type: "console", niveau: "log", message: "ok", ligne: 0, colonne: null, ts: 1 });
  assert.equal(sansPosition?.type === "console" && sansPosition.entree.ligne, null, "0 n'est pas une position : null");
  assert.deepEqual(lireMessageApercu({ source: SOURCE_PONT, version: 2, type: "charge", ts: 5 }), { type: "charge", version: 2, ts: 5 });
  assert.deepEqual(lireMessageApercu({ source: SOURCE_PONT, version: 2, type: "eval", id: "e1", ok: false, valeur: null, erreur: "ReferenceError: f is not defined" }), {
    type: "eval",
    version: 2,
    id: "e1",
    ok: false,
    valeur: null,
    erreur: "ReferenceError: f is not defined",
  });
  assert.equal(lireMessageApercu({ source: SOURCE_PONT, version: 2, type: "eval", id: 7, ok: true }), null, "id non chaîne : refusé");
});

test("ligneConsole : niveau, message, et la position seulement quand elle existe", () => {
  assert.equal(ligneConsole({ niveau: "error", message: "boom", ligne: 3, colonne: 9, ts: 0, version: 1 }), "ERREUR : boom (ligne 3:9)");
  assert.equal(ligneConsole({ niveau: "warn", message: "hum", ligne: 3, colonne: null, ts: 0, version: 1 }), "avert. : hum (ligne 3)");
  assert.equal(ligneConsole({ niveau: "log", message: "ok", ligne: null, colonne: null, ts: 0, version: 1 }), "log : ok");
});
