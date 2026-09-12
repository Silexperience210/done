/** Tests du diff LCS maison : deux versions connues → le diff attendu. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLignes, resumeDiff } from "./diff.ts";

test("diff de deux versions connues : ligne modifiée, ajoutée, supprimée, numéros exacts", () => {
  const avant = "a\nb\nc\nd\n";
  const apres = "a\nB\nc\ne\nd\n";
  const d = diffLignes(avant, apres);
  assert.deepEqual(
    d.map((l) => `${l.type}${l.texte}[${l.a ?? "·"},${l.b ?? "·"}]`),
    ["=a[1,1]", "-b[2,·]", "+B[·,2]", "=c[3,3]", "+e[·,4]", "=d[4,5]"],
  );
  assert.deepEqual(resumeDiff(d), { ajoutees: 2, supprimees: 1, inchangees: 3 });
});

test("identique → tout en « = » ; vide → tout ajouté ; ordre de lecture conservé", () => {
  assert.ok(diffLignes("x\ny", "x\ny").every((l) => l.type === "="));
  const ajout = diffLignes("", "<html>\n<body>");
  assert.deepEqual(ajout.map((l) => l.type), ["-", "+", "+"], "la ligne vide d'origine est remplacée");
  const suppr = diffLignes("a\nb", "");
  assert.deepEqual(suppr.map((l) => l.type), ["-", "-", "+"]);
});

test("le préfixe et le suffixe communs ne sont pas recalculés, et la LCS choisit le minimum de changements", () => {
  const avant = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
  const apres = avant.replace("l25", "L25").replace("l40\n", "l40\ninséré\n");
  const d = diffLignes(avant, apres);
  const r = resumeDiff(d);
  assert.deepEqual(r, { ajoutees: 2, supprimees: 1, inchangees: 49 });
  assert.equal(d.filter((l) => l.type === "+").map((l) => l.texte).join(","), "L25,inséré");
});

test("un texte hors gabarit ne bloque pas : repli préfixe/suffixe + milieu remplacé, toujours exact", () => {
  const n = 2500;
  const avant = Array.from({ length: n }, (_, i) => `a${i}`).join("\n");
  const apres = Array.from({ length: n }, (_, i) => `b${i}`).join("\n");
  const d = diffLignes(avant, apres); // n·m = 6,25 M > MAX_CELLULES → repli
  const r = resumeDiff(d);
  assert.equal(r.supprimees, n);
  assert.equal(r.ajoutees, n);
  // Reconstruction : les « - » et « = » redonnent AVANT, les « + » et « = » redonnent APRÈS.
  assert.equal(d.filter((l) => l.type !== "+").map((l) => l.texte).join("\n"), avant);
  assert.equal(d.filter((l) => l.type !== "-").map((l) => l.texte).join("\n"), apres);
});
