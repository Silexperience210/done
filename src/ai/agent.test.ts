/**
 * Tests du harnais : la boucle et l'analyse d'appel d'outil se vérifient SANS
 * navigateur ni modèle — c'est tout l'intérêt d'avoir injecté `generate`,
 * `executer`, `verifier` et `journal`. Ce qu'on protège ici :
 *  - le format d'appel reste tolérant à la forme (`<tool_call>`, ```tool,
 *    `{action,nom,args}`) mais strict sur le fond (un outil inconnu ne doit
 *    JAMAIS être exécuté) ;
 *  - la DÉCISION est séparée de la PRODUCTION, avec un budget PAR OUTIL, et la
 *    production d'une app s'arrête sur `</html>` ;
 *  - TRONQUÉ est distinct d'ILLISIBLE : une sortie coupée par `n_predict` est
 *    dite coupée, la redemande n'a jamais le même budget, et une production
 *    coupée est annoncée « coupée à N jetons », jamais rafistolée ;
 *  - une erreur d'outil est renvoyée au modèle au lieu d'interrompre la tâche ;
 *  - chaque appel au moteur écrit UNE ligne de trace avec tous ses chiffres — et
 *    « — » là où rien n'a été mesuré.
 * La garantie d'achèvement (contrat, preuve, recoupement) a ses propres tests
 * dans `achevement.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyserAppel,
  analyserSortie,
  boucleAgent,
  BUDGETS,
  contraintesHarnais,
  ecrireMemoire,
  erreurSyntaxe,
  extraireCodeProduit,
  extraireHtmlProduit,
  GRAMMAIRE_DECISION,
  ligneTracePas,
  OUTILS,
  type DemandeGeneration,
  type Outil,
  type PasAgent,
  type SortieMoteur,
} from "./agent.ts";
import { GRAMMAIRE_CONTRAT, type Preuve } from "./achevement.ts";
import type { BilanGeneration, RaisonArret } from "./types.ts";

/* ─── Doubles ─────────────────────────────────────────────────────────── */

const CONTRAT = '[{"type":"run_js","code":"2+2","attendu":"4"}]';
const APPEL_RUN = '<tool_call>{"name":"run_js","arguments":{}}</tool_call>';
const APPEL_APP = '<tool_call>{"name":"write_app","arguments":{"title":"Pong"}}</tool_call>';
const APPEL_DONE = '<tool_call>{"name":"done","arguments":{"criteres_ok":[1]}}</tool_call>';

function bilan(raison: RaisonArret, extra: Partial<BilanGeneration> = {}): BilanGeneration {
  return {
    raison,
    chaineArret: null,
    jetonsPrompt: 100,
    jetonsPredits: 20,
    nPredict: 48,
    promptTronque: false,
    msPreremplissage: 10,
    msDecodage: 20,
    nCtx: 4096,
    nBatch: 512,
    nThreads: 4,
    ...extra,
  };
}

/** Un moteur SCRIPTÉ : rend les réponses dans l'ordre, puis répète la dernière. */
function moteurScripte(reponses: (string | SortieMoteur)[]) {
  const demandes: DemandeGeneration[] = [];
  return {
    demandes,
    generate: async (d: DemandeGeneration) => {
      demandes.push(d);
      return reponses[Math.min(demandes.length - 1, reponses.length - 1)];
    },
  };
}

/** Un vérificateur qui dit toujours ✓ (les cas d'échec sont dans achevement.test.ts). */
const toutOk = async (): Promise<Preuve> => ({ ok: true, observe: "→ 4", erreur: null, ms: 1 });

const muet = () => {};

/* ─── Analyse ─────────────────────────────────────────────────────────── */

test("analyse le format d'entraînement <tool_call>{name, arguments}</tool_call>", () => {
  assert.deepEqual(analyserAppel(APPEL_APP), { nom: "write_app", args: { title: "Pong" } });
  assert.deepEqual(analyserAppel('<tool_call>\n{"name": "run_js", "arguments": {"code": "2+2"}}\n</tool_call>'), {
    nom: "run_js",
    args: { code: "2+2" },
  });
});

test("une balise <tool_call> non refermée mais au JSON complet est encore lue", () => {
  assert.deepEqual(analyserAppel('<tool_call>{"name":"remember","arguments":{"note":"ok"}}'), {
    nom: "remember",
    args: { note: "ok" },
  });
});

test("l'ancien protocole {action,nom,args} et la balise ```tool restent acceptés (tolérance)", () => {
  assert.deepEqual(analyserAppel('{"action":"outil","nom":"run_js","args":{"code":"1+1"}}'), {
    nom: "run_js",
    args: { code: "1+1" },
  });
  assert.deepEqual(analyserAppel('Je calcule.\n```tool\n{"name": "run_js", "args": {"code": "2+2"}}\n```'), {
    nom: "run_js",
    args: { code: "2+2" },
  });
  assert.deepEqual(analyserAppel('Voilà :\n```json\n{"name": "remember", "args": {"note": "ok"},}\n```\nVoilà.'), {
    nom: "remember",
    args: { note: "ok" },
  });
});

test("refuse un outil INCONNU, sous toutes les formes (aucune exécution devinée)", () => {
  assert.equal(analyserAppel('<tool_call>{"name":"shell","arguments":{"cmd":"rm -rf /"}}</tool_call>'), null);
  assert.equal(analyserAppel('```tool\n{"name": "shell", "args": {"cmd": "rm -rf /"}}\n```'), null);
  assert.equal(analyserAppel('{"action":"outil","nom":"shell","args":{"cmd":"rm -rf /"}}'), null);
});

test("renvoie null sur une réponse en texte normal", () => {
  assert.equal(analyserAppel("Bonjour, voici la réponse."), null);
  assert.equal(analyserAppel("```js\nconsole.log(1)\n```"), null);
});

test("l'accolade dans une chaîne ne casse pas l'extraction", () => {
  const out = analyserAppel('<tool_call>{"name":"run_js","arguments":{"code":"JSON.stringify({a:1})"}}</tool_call>');
  assert.deepEqual(out, { nom: "run_js", args: { code: "JSON.stringify({a:1})" } });
});

test("analyserSortie distingue outil, réponse et illisible", () => {
  assert.equal(analyserSortie(APPEL_RUN).type, "outil");
  assert.deepEqual(analyserSortie('{"action":"reponse","texte":"salut"}'), { type: "reponse", texte: "salut" });
  // outil inconnu : illisible, surtout pas une réponse finale ni un outil exécuté
  assert.equal(analyserSortie('<tool_call>{"name":"shell","arguments":{}}</tool_call>').type, "illisible");
  // texte simple
  assert.deepEqual(analyserSortie("  bonjour  "), { type: "reponse", texte: "bonjour" });
  // tentative d'appel ratée
  assert.equal(analyserSortie('<tool_call>{"name":"run_js","argu').type, "illisible");
  assert.equal(analyserSortie("je vais le faire\n```tool\n{oups").type, "illisible");
});

/* ─── Grammaires et budgets ───────────────────────────────────────────── */

test("la grammaire de décision est fermée : balises <tool_call>, noms énumérés, un seul mode de fin", () => {
  assert.ok(GRAMMAIRE_DECISION.includes('"<tool_call>"'));
  assert.ok(GRAMMAIRE_DECISION.includes('"</tool_call>"'));
  for (const nom of ["run_js", "write_app", "remember", "done"]) {
    assert.ok(GRAMMAIRE_DECISION.includes(`\\"${nom}\\"`), `${nom} énuméré`);
  }
  assert.ok(!GRAMMAIRE_DECISION.includes("reponse"), "plus de second mode de fin : done seulement");
  assert.ok(!GRAMMAIRE_DECISION.includes("html"), "pas d'HTML dans la décision : il vient à la production");
  assert.ok(GRAMMAIRE_DECISION.includes("criteres_ok"), "done porte les critères vus réussir");
});

test("contraintesHarnais : grammaire de décision par défaut, de contrat sur demande, rien en mode aucune", () => {
  assert.equal(contraintesHarnais()?.grammar, GRAMMAIRE_DECISION);
  assert.equal(contraintesHarnais("grammaire", "contrat")?.grammar, GRAMMAIRE_CONTRAT);
  assert.equal(contraintesHarnais("aucune"), undefined);
});

test("les budgets sont PAR PHASE ET PAR OUTIL, et la décision est minuscule", () => {
  assert.ok(BUDGETS.decision <= 64, `décision ≈ 30 jetons, pas un budget de production (${BUDGETS.decision})`);
  assert.ok(BUDGETS.production.write_app >= 1200 && BUDGETS.production.write_app <= 1500);
  assert.ok(BUDGETS.production.run_js < BUDGETS.production.write_app);
  assert.ok(BUDGETS.production.done < BUDGETS.production.run_js);
  assert.ok(BUDGETS.contrat > BUDGETS.decision);
});

test("la boucle transmet le bon budget, la bonne grammaire et l'arrêt sur </html> à chaque phase", async () => {
  const m = moteurScripte([
    CONTRAT,
    APPEL_APP,
    "<!DOCTYPE html><html><body><script>1</script></body></html>",
    APPEL_DONE,
    "Voilà Pong.",
  ]);
  await boucleAgent({
    question: "un pong",
    system: "s",
    generate: m.generate,
    executer: async () => "ok",
    verifier: toutOk,
    journal: muet,
  });
  const [contrat, decision, production, fin, reponse] = m.demandes;
  assert.equal(contrat.phase, "contrat");
  assert.equal(contrat.budget, BUDGETS.contrat);
  assert.equal(contrat.contraintes?.grammar, GRAMMAIRE_CONTRAT);
  assert.equal(decision.phase, "decision");
  assert.equal(decision.budget, BUDGETS.decision);
  assert.equal(decision.contraintes?.grammar, GRAMMAIRE_DECISION);
  assert.equal(production.phase, "production");
  assert.equal(production.outil, "write_app");
  assert.equal(production.budget, BUDGETS.production.write_app);
  assert.equal(production.contraintes, undefined, "la production n'est JAMAIS contrainte");
  assert.deepEqual(production.stop, ["</html>"]);
  assert.equal(fin.phase, "decision");
  assert.equal(reponse.phase, "production");
  assert.equal(reponse.outil, "done");
  assert.equal(reponse.budget, BUDGETS.production.done);
});

test("le mode aucune ne contraint rien, et l'analyse tolérante suffit", async () => {
  const m = moteurScripte([CONTRAT, '{"action":"outil","nom":"run_js","args":{"code":"2+2"}}', APPEL_DONE, "4"]);
  const r = await boucleAgent({
    question: "q",
    system: "s",
    modeContrainte: "aucune",
    generate: m.generate,
    executer: async () => "→ 4",
    verifier: toutOk,
    journal: muet,
  });
  assert.ok(m.demandes.every((d) => d.contraintes === undefined));
  assert.equal(r.termine, true);
});

/* ─── Décision ≠ production ───────────────────────────────────────────── */

test("run_js : la décision est vide, le CODE vient d'un pas de production et part à l'exécuteur", async () => {
  const vus: Outil[] = [];
  const m = moteurScripte([CONTRAT, APPEL_RUN, "```js\n2+2\n```", APPEL_DONE, "Le résultat est 4."]);
  const r = await boucleAgent({
    question: "calcule 2+2",
    system: "s",
    generate: m.generate,
    executer: async (o) => {
      vus.push(o);
      return "→ 4";
    },
    verifier: toutOk,
    journal: muet,
  });
  assert.equal(vus.length, 1);
  assert.equal(vus[0].nom, "run_js");
  assert.equal(vus[0].args.code, "2+2", "le bloc ``` est déballé, le code est pris tel quel");
  assert.equal(m.demandes[2].budget, BUDGETS.production.run_js);
  assert.equal(r.termine, true);
  assert.equal(r.reponse, "Le résultat est 4.");
  assert.equal(r.etapes.length, 1, "etapes ne liste que les outils exécutés");
});

test("un contenu fourni EN LIGNE dans les arguments est pris sans second appel (tolérance)", async () => {
  const vus: Outil[] = [];
  const m = moteurScripte([CONTRAT, '<tool_call>{"name":"run_js","arguments":{"code":"1+1"}}</tool_call>', APPEL_DONE, "2"]);
  await boucleAgent({
    question: "q",
    system: "s",
    generate: m.generate,
    executer: async (o) => {
      vus.push(o);
      return "→ 2";
    },
    verifier: toutOk,
    journal: muet,
  });
  assert.equal(vus[0].args.code, "1+1");
  assert.equal(m.demandes.filter((d) => d.phase === "production" && d.outil === "run_js").length, 0);
});

test("write_app : l'HTML est pris EN BLOC LIBRE, et </html> est remis quand le natif dit s'y être arrêté", async () => {
  const vus: Outil[] = [];
  const html = "<!DOCTYPE html><html><body><canvas></canvas><script>let x=1</script></body>";
  const m = moteurScripte([
    CONTRAT,
    APPEL_APP,
    { texte: html, bilan: bilan("chaine", { chaineArret: "</html>", jetonsPredits: 300 }) },
    APPEL_DONE,
    "fait",
  ]);
  const r = await boucleAgent({
    question: "un pong",
    system: "s",
    generate: m.generate,
    executer: async (o) => {
      vus.push(o);
      return "application écrite";
    },
    verifier: toutOk,
    journal: muet,
  });
  assert.equal(vus[0].nom, "write_app");
  assert.equal(vus[0].args.title, "Pong");
  assert.equal(vus[0].args.html, `${html}</html>`, "la chaîne d'arrêt consommée par le natif est remise");
  assert.equal(vus[0].args.tronque, false);
  assert.equal(vus[0].args.jetons, 300);
  assert.equal(r.html, `${html}</html>`);
});

test("write_app sans preuve d'arrêt sur </html> : le document est rendu tel quel, sans rafistolage", async () => {
  const vus: Outil[] = [];
  const html = "<!DOCTYPE html><html><body>x</body>";
  const m = moteurScripte([CONTRAT, APPEL_APP, { texte: html, bilan: bilan("eos") }, APPEL_DONE, "fait"]);
  await boucleAgent({
    question: "q",
    system: "s",
    generate: m.generate,
    executer: async (o) => {
      vus.push(o);
      return "ok";
    },
    verifier: toutOk,
    journal: muet,
  });
  assert.equal(vus[0].args.html, html, "rien n'est ajouté sans la preuve du moteur");
});

test("une production COUPÉE est dite coupée à N jetons, jamais rafistolée", async () => {
  const vus: Outil[] = [];
  const pasVus: PasAgent[] = [];
  const html = "<!DOCTYPE html><html><body><script>function f(){";
  const m = moteurScripte([
    CONTRAT,
    APPEL_APP,
    { texte: html, bilan: bilan("limite", { jetonsPredits: 1500, nPredict: 1500 }) },
    APPEL_DONE,
  ]);
  const r = await boucleAgent({
    question: "q",
    system: "s",
    maxPas: 3,
    generate: m.generate,
    executer: async (o) => {
      vus.push(o);
      return "application écrite";
    },
    verifier: async () => ({ ok: false, observe: "erreur console", erreur: "SyntaxError: Unexpected end", ms: 3 }),
    onPas: (p) => pasVus.push(p),
    journal: muet,
  });
  assert.equal(vus[0].args.tronque, true);
  assert.equal(vus[0].args.html, html, "le document coupé est transmis tel quel");
  const production = pasVus.find((p) => p.phase === "production");
  assert.equal(production?.verdict, "tronque");
  assert.match(production?.resultat ?? "", /PRODUCTION COUPÉE à 1500 jetons \(limite 1500\)/);
  assert.equal(r.achevement.tronque, true);
  assert.equal(r.termine, false);
});

/* ─── Tronqué ≠ illisible ─────────────────────────────────────────────── */

test("une DÉCISION coupée par n_predict est « tronquée », pas « illisible », et la redemande double le budget", async () => {
  const pasVus: PasAgent[] = [];
  const m = moteurScripte([
    CONTRAT,
    { texte: '<tool_call>{"name":"write_app","arguments":{"title":"Un titre beaucoup', bilan: bilan("limite", { jetonsPredits: 48 }) },
    APPEL_APP,
    "<!DOCTYPE html><html><body>x</body></html>",
    APPEL_DONE,
    "fait",
  ]);
  const r = await boucleAgent({
    question: "q",
    system: "s",
    generate: m.generate,
    executer: async () => "ok",
    verifier: toutOk,
    onPas: (p) => pasVus.push(p),
    journal: muet,
  });
  assert.equal(pasVus[1].verdict, "tronque");
  assert.match(pasVus[1].resultat, /COUPÉE à 48 jetons \(limite 48\)/);
  assert.equal(m.demandes[1].budget, BUDGETS.decision);
  assert.equal(m.demandes[2].budget, BUDGETS.decision * 2, "jamais le même budget deux fois");
  assert.equal(r.termine, true);
});

test("une décision cassée mais FINIE (eos) est « illisible », redemandée au même budget", async () => {
  const pasVus: PasAgent[] = [];
  const m = moteurScripte([
    CONTRAT,
    { texte: '<tool_call>{"name":"shell","arguments":{}}</tool_call>', bilan: bilan("eos") },
    APPEL_RUN,
    "1+1",
    APPEL_DONE,
    "2",
  ]);
  let executions = 0;
  await boucleAgent({
    question: "q",
    system: "s",
    generate: m.generate,
    executer: async () => {
      executions += 1;
      return "→ 2";
    },
    verifier: toutOk,
    onPas: (p) => pasVus.push(p),
    journal: muet,
  });
  assert.equal(pasVus[1].verdict, "illisible");
  assert.match(pasVus[1].resultat, /ILLISIBLE/);
  assert.equal(m.demandes[2].budget, BUDGETS.decision);
  assert.equal(executions, 1, "l'outil inconnu n'a jamais été exécuté");
});

test("sans bilan du moteur, une sortie cassée reste « illisible » (on ne devine pas une coupure)", async () => {
  const pasVus: PasAgent[] = [];
  const m = moteurScripte([CONTRAT, '<tool_call>{"name":"run_js","argu', APPEL_RUN, "1", APPEL_DONE, "1"]);
  await boucleAgent({
    question: "q",
    system: "s",
    generate: m.generate,
    executer: async () => "→ 1",
    verifier: toutOk,
    onPas: (p) => pasVus.push(p),
    journal: muet,
  });
  assert.equal(pasVus[1].verdict, "illisible");
  assert.equal(pasVus[1].bilan, null);
});

test("contexte plein : la boucle s'arrête et le dit, au lieu de redemander dans le vide", async () => {
  const m = moteurScripte([CONTRAT, { texte: "<tool_call>{", bilan: bilan("contexte_plein", { nCtx: 2048 }) }]);
  const r = await boucleAgent({
    question: "q",
    system: "s",
    generate: m.generate,
    executer: async () => "x",
    journal: muet,
  });
  assert.equal(m.demandes.length, 2, "aucune redemande après un contexte plein");
  assert.equal(r.termine, false);
  assert.match(r.reponse, /contexte plein \(n_ctx 2048\)/);
  assert.match(r.achevement.motif ?? "", /contexte plein/);
});

/* ─── Boucle, plafond, erreurs ────────────────────────────────────────── */

test("une erreur d'outil est renvoyée au modèle, pas fatale", async () => {
  const m = moteurScripte([CONTRAT, APPEL_RUN, "(", APPEL_RUN, "1+1", APPEL_DONE, "2"]);
  let tour = 0;
  const r = await boucleAgent({
    question: "échoue puis conclut",
    system: "s",
    generate: m.generate,
    executer: async () => {
      tour += 1;
      if (tour === 1) throw new Error("SyntaxError");
      return "→ 2";
    },
    verifier: toutOk,
    journal: muet,
  });
  assert.equal(r.etapes[0].resultat, "erreur d'exécution : SyntaxError");
  assert.match(m.demandes[3].history.at(-1)?.content ?? "", /<tool_response>\nerreur d'exécution : SyntaxError/);
  assert.equal(r.termine, true);
});

test("s'arrête au plafond de pas au lieu de boucler sans fin, et le dit", async () => {
  const m = moteurScripte([CONTRAT, APPEL_RUN, "1", APPEL_RUN, "1", APPEL_RUN, "1"]);
  const r = await boucleAgent({
    question: "boucle",
    system: "s",
    maxPas: 4,
    generate: m.generate,
    executer: async () => "→ 1",
    verifier: async () => ({ ok: false, observe: "attendu « 4 », observé « 1 »", erreur: null, ms: 1 }),
    journal: muet,
  });
  assert.equal(r.plafondAtteint, true);
  assert.equal(r.termine, false);
  assert.equal(r.etapes.length, 3, "3 pas d'outil après le pas de contrat");
  assert.match(r.reponse, /plafond de 4 pas/);
  assert.match(r.reponse, /0 critère sur 1 vérifié/);
  assert.match(r.reponse, /Pas utilisés : 4 sur 4/);
});

test("un texte en clair ne termine PAS la tâche : brouillon noté, done exigé", async () => {
  const m = moteurScripte([CONTRAT, "Bonjour, voici la réponse.", APPEL_DONE, "Bonjour !"]);
  const r = await boucleAgent({
    question: "dis bonjour",
    system: "s",
    generate: m.generate,
    executer: async () => {
      throw new Error("aucun outil ne doit être exécuté");
    },
    verifier: toutOk,
    journal: muet,
  });
  assert.equal(r.etapes.length, 0);
  assert.equal(r.pas[1].verdict, "reponse");
  assert.match(r.pas[1].resultat, /brouillon/);
  assert.equal(r.termine, true);
  assert.equal(r.reponse, "Bonjour !");
});

/* ─── Trace par pas ───────────────────────────────────────────────────── */

test("chaque appel au moteur écrit UNE ligne de trace avec ses chiffres réels", async () => {
  const lignes: string[] = [];
  const m = moteurScripte([
    { texte: CONTRAT, bilan: bilan("eos", { jetonsPrompt: 812, jetonsPredits: 23, msPreremplissage: 1240, msDecodage: 1180 }) },
    { texte: APPEL_RUN, bilan: bilan("eos", { jetonsPredits: 11 }) },
    { texte: "2+2", bilan: bilan("eos", { jetonsPredits: 3 }) },
    { texte: APPEL_DONE, bilan: bilan("eos") },
    { texte: "4", bilan: bilan("eos") },
  ]);
  let t = 0;
  await boucleAgent({
    question: "q",
    system: "s",
    generate: m.generate,
    executer: async () => "→ 4",
    verifier: toutOk,
    journal: (l) => lignes.push(l),
    maintenant: () => (t += 50),
  });
  const pas = lignes.filter((l) => l.startsWith("pas "));
  assert.equal(pas.length, 5, "cinq appels au moteur, cinq lignes");
  assert.match(pas[0], /^pas 1 · contrat · n_ctx 4096 · threads 4 · prompt 812 jetons · prédits 23\/160 · arrêt eos · verdict contrat · outil — · préremplissage 1240 ms · décodage 1180 ms · appel \d+ ms · critères 0\/1$/);
  assert.match(pas[1], /^pas 2 · decision · .* · prédits 11\/48 · arrêt eos · verdict outil · outil run_js/);
  assert.match(pas[2], /^pas 2 · production · .* · prédits 3\/400 · .* · outil run_js .* · critères 1\/1$/);
  // La réponse finale d'un `done` est PRODUITE avant que le recoupement tranche
  // la décision : la ligne de décision est donc écrite après celle de production.
  assert.match(pas[3], /^pas 3 · production · .* · prédits 20\/200 · .* · outil done/);
  assert.match(pas[4], /^pas 3 · decision · .* · verdict outil · outil done/);
  assert.ok(lignes.some((l) => l.startsWith("fin du tour · 1/1 critère ✓ · pas 3/6 · conclu")));
});

test("sans bilan, la trace écrit « — », jamais un zéro inventé", () => {
  const p: PasAgent = {
    id: 1,
    pas: 1,
    phase: "decision",
    outil: null,
    verdict: "illisible",
    bilan: null,
    budget: 48,
    dureeMs: 7,
    sortie: "?",
    resultat: "",
    criteres: [],
  };
  assert.equal(
    ligneTracePas(p),
    "pas 1 · decision · n_ctx — · threads — · prompt — jetons · prédits —/48 · arrêt — · verdict illisible · outil — · préremplissage — · décodage — · appel 7 ms · critères —",
  );
});

test("la frise et la trace lisent le même pas : onPas reçoit exactement ce qui est journalisé", async () => {
  const lignes: string[] = [];
  const pasVus: PasAgent[] = [];
  const m = moteurScripte([CONTRAT, APPEL_RUN, "1+1", APPEL_DONE, "2"]);
  await boucleAgent({
    question: "q",
    system: "s",
    generate: m.generate,
    executer: async () => "→ 2",
    verifier: toutOk,
    journal: (l) => lignes.push(l),
    onPas: (p) => pasVus.push(p),
  });
  const parPas = lignes.filter((l) => l.startsWith("pas "));
  assert.equal(parPas.length, pasVus.length);
  // `onPas` arrive à la CLÔTURE du pas (comme la ligne de trace) ; les deux
  // sont donc dans le même ordre, et chaque ligne se recalcule depuis le pas.
  pasVus.forEach((p, i) => assert.equal(ligneTracePas(p), parPas[i], `ligne ${i} jumelle`));
  assert.deepEqual(pasVus.map((p) => p.id).sort((a, b) => a - b), [1, 2, 3, 4, 5], "un identifiant d'ordre par appel");
});

/* ─── Divers ──────────────────────────────────────────────────────────── */

test("la mémoire est bornée (volume et nombre)", () => {
  const grosses = Array.from({ length: 60 }, (_, i) => `note ${i} `.repeat(20));
  const gardees = ecrireMemoire(grosses);
  assert.ok(gardees.length >= 1, "au moins une note conservée");
  assert.ok(gardees.join("\n").length <= 1800, `volume borné (${gardees.join("\n").length})`);
  assert.ok(gardees.length <= 24, "nombre borné");
  assert.ok(gardees[gardees.length - 1].includes("note 59"), "les plus récentes sont gardées");
});

test("chaque outil déclaré a un nom unique, une description et des paramètres JSON Schema", () => {
  const noms = OUTILS.map((o) => o.nom);
  assert.equal(new Set(noms).size, noms.length);
  for (const o of OUTILS) {
    assert.ok(o.description.length > 10, `${o.nom} décrit`);
    assert.equal(o.parametres.type, "object");
  }
});

test("le prompt système porte les signatures au format d'entraînement de Qwen", async () => {
  const m = moteurScripte([CONTRAT, APPEL_DONE, "x"]);
  await boucleAgent({ question: "q", system: "SYS", generate: m.generate, executer: async () => "x", verifier: toutOk, journal: muet });
  const s = m.demandes[0].system;
  assert.ok(s.startsWith("SYS"));
  assert.ok(s.includes("<tools>") && s.includes("</tools>"));
  assert.ok(s.includes('{"name": <function-name>, "arguments": <args-json-object>}'));
  assert.ok(s.includes('"name":"write_app"'));
  assert.match(m.demandes[0].history[0].content, /^TÂCHE : q\n\nAvant d'agir, énonce le CONTRAT/);
});

test("erreurSyntaxe : premier filtre sans exécution, message exact du moteur JS", () => {
  assert.equal(erreurSyntaxe("1+1"), null);
  assert.equal(erreurSyntaxe("const a = 1; a + 1"), null);
  assert.match(erreurSyntaxe("(") ?? "", /^SyntaxError:/);
  assert.match(erreurSyntaxe("function (") ?? "", /^SyntaxError:/);
});

test("extraireHtmlProduit et extraireCodeProduit déballent un bloc ``` et tolèrent un document coupé", () => {
  assert.equal(extraireHtmlProduit("Voici :\n```html\n<!DOCTYPE html><html><body>x</body></html>\n```"), "<!DOCTYPE html><html><body>x</body></html>");
  assert.equal(extraireHtmlProduit("<html><body>coupé"), "<html><body>coupé");
  assert.equal(extraireHtmlProduit("rien d'un document"), null);
  assert.equal(extraireCodeProduit("```js\n1+1\n```"), "1+1");
  assert.equal(extraireCodeProduit("  2+2 \n"), "2+2");
});
