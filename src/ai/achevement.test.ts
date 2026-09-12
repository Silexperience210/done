/**
 * Tests de la GARANTIE D'ACHÈVEMENT — un test par propriété exigée, tous à sec
 * (moteur scripté, vérificateur injecté). Ce qu'on protège :
 *  1. le CONTRAT : un critère invérifiable est refusé et doit être remplacé ;
 *  2. la VÉRIFICATION par exécution, critère par critère, avec sa preuve ;
 *  3. `done` SANS PREUVE est refusé ; avec preuve recoupée, accepté ;
 *  4. la FIN HONNÊTE au plafond : « 1 critère sur 2 », l'erreur réelle, jamais « fait » ;
 *  5. l'état MESURÉ (critères ✓/✗, pas utilisés, tronqué) remonte à chaque changement ;
 *  6. le MODÈLE QUI MENT sur son achèvement est démasqué par l'exécution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyserContrat,
  comparerAttendu,
  creerVerificateur,
  etatsInitiaux,
  rapportFinal,
  recouperDone,
  resumeAchevement,
  validerCritere,
  verifierContient,
  verifierTout,
  type Critere,
  type EtatAchevement,
  GRAMMAIRE_CONTRAT,
  type Preuve,
} from "./achevement.ts";
import {
  BUDGETS,
  GRAMMAIRE_DECISION,
  OUTILS,
  boucleAgent,
  type DemandeGeneration,
  type PasAgent,
  type SortieMoteur,
} from "./agent.ts";

const CONTRAT_RUN = '[{"type":"run_js","code":"f(2)","attendu":"4"}]';
const CONTRAT_APP = '[{"type":"app_sans_erreur"},{"type":"run_js","code":"typeof score","attendu":"function"}]';
const APPEL_APP = '<tool_call>{"name":"write_app","arguments":{"title":"Jeu"}}</tool_call>';
const HTML = "<!DOCTYPE html><html><body><script>function score(){return 1}</script></body></html>";
const DONE_TOUT = '<tool_call>{"name":"done","arguments":{"criteres_ok":[1,2]}}</tool_call>';
const DONE_1 = '<tool_call>{"name":"done","arguments":{"criteres_ok":[1]}}</tool_call>';
const DONE_SANS_PREUVE = '<tool_call>{"name":"done","arguments":{}}</tool_call>';

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
const muet = () => {};

/* ─── 1. Contrat avant action ─────────────────────────────────────────── */

test("P1 · un critère invérifiable (« ça marche ») est REFUSÉ avec la raison", () => {
  const r = validerCritere({ type: "texte", description: "ça marche" });
  assert.ok("refus" in r);
  assert.match(r.refus.raison, /non vérifiable par exécution/);
  const sansAttendu = validerCritere({ type: "run_js", code: "f(2)" });
  assert.ok("refus" in sansAttendu);
  assert.match(sansAttendu.refus.raison, /sans valeur attendue/);
  assert.ok("refus" in validerCritere({ type: "contient", texte: "" }));
  assert.ok("refus" in validerCritere("juste une phrase"));
});

test("P1 · les trois types vérifiables sont acceptés, au plus quatre, virgule finale tolérée", () => {
  const lu = analyserContrat(
    'Contrat :\n[{"type":"run_js","code":"2+2","attendu":4},{"type":"app_sans_erreur"},{"type":"contient","texte":"canvas"},]',
  );
  assert.equal(lu.vide, false);
  assert.deepEqual(lu.acceptes, [
    { type: "run_js", code: "2+2", attendu: "4" },
    { type: "app_sans_erreur" },
    { type: "contient", texte: "canvas" },
  ]);
  const trop = analyserContrat(JSON.stringify(Array.from({ length: 6 }, () => ({ type: "app_sans_erreur" }))));
  assert.equal(trop.acceptes.length, 4);
  assert.equal(trop.refuses.length, 2);
  assert.match(trop.refuses[0].raison, /au plus 4/);
  assert.equal(analyserContrat("je vais faire un jeu").vide, true, "rien d'analysable = vide, pas refusé");
  assert.equal(analyserContrat('{"type":"contient","texte":"x"}').acceptes.length, 1, "un objet nu suffit");
});

test("P1 · dans la boucle : un contrat entièrement refusé est REDEMANDÉ avec les raisons, puis remplacé", async () => {
  const pasVus: PasAgent[] = [];
  const m = moteurScripte([
    '[{"type":"texte","description":"ça marche"}]',
    CONTRAT_RUN,
    '<tool_call>{"name":"run_js","arguments":{}}</tool_call>',
    "function f(x){return x*x} f(2)",
    DONE_1,
    "4",
  ]);
  const r = await boucleAgent({
    question: "f(2)",
    system: "s",
    generate: m.generate,
    executer: async () => "→ 4",
    verifier: async () => ({ ok: true, observe: "→ 4", erreur: null, ms: 1 }),
    onPas: (p) => pasVus.push(p),
    journal: muet,
  });
  assert.equal(pasVus[0].phase, "contrat");
  assert.equal(pasVus[0].verdict, "refuse");
  assert.match(pasVus[0].resultat, /CONTRAT REFUSÉ : type « texte » non vérifiable/);
  assert.equal(m.demandes[1].phase, "contrat", "on redemande le contrat, on n'agit pas");
  assert.equal(pasVus[1].verdict, "contrat");
  assert.equal(r.achevement.criteres.length, 1);
  assert.equal(r.termine, true);
});

test("P1 · aucune action n'est exécutée avant qu'un contrat soit accepté", async () => {
  let executions = 0;
  const m = moteurScripte(["blabla", "encore", APPEL_APP]);
  const r = await boucleAgent({
    question: "q",
    system: "s",
    maxPas: 3,
    generate: m.generate,
    executer: async () => {
      executions += 1;
      return "x";
    },
    journal: muet,
  });
  assert.equal(executions, 0);
  assert.ok(m.demandes.every((d) => d.phase === "contrat"));
  assert.match(r.reponse, /Aucun critère vérifiable n'a été énoncé/);
});

/* ─── 2. Vérification par exécution, critère par critère, avec preuve ──── */

test("P2 · chaque critère est exécuté par le harnais et garde sa preuve (observé, erreur, durée)", async () => {
  const appels: Critere[] = [];
  const etats = await verifierTout(
    etatsInitiaux([
      { type: "run_js", code: "f(2)", attendu: "4" },
      { type: "run_js", code: "g()", attendu: "1" },
    ]),
    { html: null, reponse: null },
    async (c) => {
      appels.push(c);
      return c.type === "run_js" && c.code === "f(2)"
        ? { ok: true, observe: "→ 4", erreur: null, ms: 2 }
        : { ok: false, observe: "exécution en erreur", erreur: "ReferenceError: g is not defined", ms: 3 };
    },
  );
  assert.equal(appels.length, 2, "critère par critère");
  assert.equal(etats[0].etat, "ok");
  assert.equal(etats[0].preuve?.observe, "→ 4");
  assert.equal(etats[0].preuve?.ms, 2);
  assert.equal(etats[1].etat, "echec");
  assert.equal(etats[1].preuve?.erreur, "ReferenceError: g is not defined");
});

test("P2 · le vérificateur par défaut exécute là où le code tourne : Worker sans app, aperçu avec app", async () => {
  const ou: string[] = [];
  const verifier = creerVerificateur({
    executerJs: async (code) => {
      ou.push(`worker:${code}`);
      return { ok: true, valeur: "4" };
    },
    executerDansApercu: async (code) => {
      ou.push(`apercu:${code}`);
      return { ok: true, valeur: "function" };
    },
    verdictApercu: async () => ({ charge: true, erreurs: ["ReferenceError: foo is not defined (ligne 3:5)"] }),
    maintenant: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
  });
  const pur = await verifier({ type: "run_js", code: "2+2", attendu: "4" }, { html: null, reponse: null });
  assert.equal(pur.ok, true);
  assert.equal(pur.ms, 5, "durée mesurée par l'horloge injectée");
  const app = await verifier({ type: "run_js", code: "typeof score", attendu: "function" }, { html: HTML, reponse: null });
  assert.equal(app.ok, true);
  assert.deepEqual(ou, ["worker:2+2", "apercu:typeof score"]);
  const sansErreur = await verifier({ type: "app_sans_erreur" }, { html: HTML, reponse: null });
  assert.equal(sansErreur.ok, false);
  assert.match(sansErreur.erreur ?? "", /foo is not defined \(ligne 3:5\)/, "l'erreur RÉELLE de l'aperçu, avec sa position");
});

test("P2 · sans aperçu, un critère d'app est NON VÉRIFIÉ — jamais exécuté dans un Worker sans DOM", async () => {
  let worker = 0;
  const verifier = creerVerificateur({
    executerJs: async () => {
      worker += 1;
      return { ok: false, erreur: "document is not defined" };
    },
  });
  const p = await verifier({ type: "run_js", code: "typeof score", attendu: "function" }, { html: HTML, reponse: null });
  assert.equal(worker, 0, "le code d'une app ne part pas dans le Worker");
  assert.equal(p.nonVerifie, true);
  const app = await verifier({ type: "app_sans_erreur" }, { html: HTML, reponse: null });
  assert.equal(app.nonVerifie, true);
  const etats = await verifierTout(etatsInitiaux([{ type: "app_sans_erreur" }]), { html: HTML, reponse: null }, verifier);
  assert.equal(etats[0].etat, "non_verifie");
});

test("P2 · comparerAttendu : texte exact ou même nombre, rien d'approximatif ; contient : l'app avant la réponse", () => {
  assert.equal(comparerAttendu("4", "4"), true);
  assert.equal(comparerAttendu(" 4 ", "4.0"), true);
  assert.equal(comparerAttendu('"ok"', "ok"), true);
  assert.equal(comparerAttendu("41", "4"), false);
  assert.equal(comparerAttendu("", ""), true);
  assert.equal(comparerAttendu("", "0"), false);
  assert.equal(verifierContient({ type: "contient", texte: "score" }, { html: HTML, reponse: "score" }).ok, true);
  assert.equal(verifierContient({ type: "contient", texte: "absent" }, { html: HTML, reponse: "absent" }).ok, false, "l'app prime");
  assert.equal(verifierContient({ type: "contient", texte: "MoE" }, { html: null, reponse: "un MoE…" }).ok, true);
  assert.equal(verifierContient({ type: "contient", texte: "x" }, { html: null, reponse: null }).nonVerifie, true);
});

/* ─── 3. done sans preuve est refusé ──────────────────────────────────── */

test("P3 · done sans criteres_ok est REFUSÉ, done recoupé et vérifié est ACCEPTÉ", () => {
  const etats = etatsInitiaux([{ type: "run_js", code: "f(2)", attendu: "4" }]).map((e) => ({
    ...e,
    etat: "ok" as const,
    preuve: { ok: true, observe: "→ 4", erreur: null, ms: 1 } as Preuve,
  }));
  const sans = recouperDone({}, etats);
  assert.equal(sans.accepte, false);
  assert.match(sans.motif, /sans preuve/);
  const avec = recouperDone({ criteres_ok: [1] }, etats);
  assert.equal(avec.accepte, true);
  assert.match(avec.motif, /1 critère\(s\) sur 1 vérifié\(s\) par exécution/);
  assert.equal(recouperDone({ criteres_ok: [1] }, []).accepte, false, "sans contrat, rien n'est fait");
  const nonVerifie = recouperDone({ criteres_ok: [1] }, etats.map((e) => ({ ...e, etat: "non_verifie" as const, preuve: null })));
  assert.equal(nonVerifie.accepte, false);
  assert.match(nonVerifie.motif, /non vérifié/);
});

test("P3 · dans la boucle : done sans preuve laisse la tâche OUVERTE, puis done avec preuve conclut", async () => {
  const pasVus: PasAgent[] = [];
  const m = moteurScripte([
    CONTRAT_RUN,
    DONE_SANS_PREUVE,
    "réponse prématurée",
    '<tool_call>{"name":"run_js","arguments":{}}</tool_call>',
    "function f(x){return x*x} f(2)",
    DONE_1,
    "f(2) vaut 4.",
  ]);
  const r = await boucleAgent({
    question: "f(2)",
    system: "s",
    generate: m.generate,
    executer: async () => "→ 4",
    verifier: async () => ({ ok: true, observe: "→ 4", erreur: null, ms: 1 }),
    onPas: (p) => pasVus.push(p),
    journal: muet,
  });
  const refus = pasVus.find((p) => p.verdict === "refuse");
  assert.ok(refus, "le done sans preuve est marqué refusé");
  assert.match(refus.resultat, /done REFUSÉ, sans preuve/);
  assert.equal(r.termine, true);
  assert.equal(r.reponse, "f(2) vaut 4.");
  assert.equal(r.achevement.conclu, true);
  assert.equal(r.achevement.complet, true);
});

test("P3 · pour une app, done vérifie D'ABORD (pas de réponse finale produite pour un done refusé)", async () => {
  const m = moteurScripte([CONTRAT_APP, APPEL_APP, HTML, DONE_TOUT]);
  await boucleAgent({
    question: "jeu",
    system: "s",
    maxPas: 3,
    generate: m.generate,
    executer: async () => "application écrite",
    verifier: async (c) =>
      c.type === "app_sans_erreur"
        ? { ok: false, observe: "1 erreur console", erreur: "TypeError: x is null", ms: 4 }
        : { ok: true, observe: "→ function", erreur: null, ms: 1 },
    journal: muet,
  });
  assert.equal(m.demandes.filter((d) => d.outil === "done").length, 0, "aucun jeton dépensé pour une réponse refusée");
});

/* ─── 4. Fin de boucle honnête ────────────────────────────────────────── */

test("P4 · au plafond, le rapport dit « 1 critère sur 2 », le critère échoué et l'erreur réelle — jamais « fait »", async () => {
  const m = moteurScripte([CONTRAT_APP, APPEL_APP, HTML, DONE_TOUT]);
  const r = await boucleAgent({
    question: "jeu",
    system: "s",
    maxPas: 3,
    generate: m.generate,
    executer: async () => "application écrite",
    verifier: async (c) =>
      c.type === "app_sans_erreur"
        ? { ok: false, observe: "1 erreur(s) console dans l'aperçu", erreur: "TypeError: ctx is null (ligne 12:3)", ms: 1600 }
        : { ok: true, observe: "→ function", erreur: null, ms: 2 },
    journal: muet,
  });
  assert.equal(r.termine, false);
  assert.equal(r.plafondAtteint, true);
  assert.match(r.reponse, /plafond de 3 pas atteint sans done accepté/);
  assert.match(r.reponse, /1 critère sur 2 vérifié par exécution/);
  assert.match(r.reponse, /✗ critère 1 \(l'app s'affiche sans erreur console\) : 1 erreur\(s\) console dans l'aperçu — erreur : TypeError: ctx is null \(ligne 12:3\)/);
  assert.match(r.reponse, /Pas utilisés : 3 sur 3/);
  assert.ok(!/c'est fait|terminé avec succès/i.test(r.reponse));
});

test("P4 · rapportFinal sans contrat : il le dit, et compte les pas", () => {
  const etat: EtatAchevement = { criteres: [], complet: false, conclu: false, pasUtilises: 6, plafond: 6, tronque: true, motif: "plafond" };
  const r = rapportFinal(etat);
  assert.match(r, /Aucun critère vérifiable/);
  assert.match(r, /coupée par le budget/);
  assert.match(r, /Pas utilisés : 6 sur 6/);
});

/* ─── 5. Mesuré et visible ────────────────────────────────────────────── */

test("P5 · l'état d'achèvement remonte à chaque changement : critères ✓/✗, pas utilisés, tronqué", async () => {
  const etats: EtatAchevement[] = [];
  const m = moteurScripte([
    CONTRAT_APP,
    APPEL_APP,
    { texte: "<!DOCTYPE html><html><body><script>function score(){", bilan: { raison: "limite", chaineArret: null, jetonsPrompt: 900, jetonsPredits: 1500, nPredict: 1500, promptTronque: false, msPreremplissage: 800, msDecodage: 76000, nCtx: 4096, nBatch: 512, nThreads: 4 } },
    DONE_TOUT,
  ]);
  const r = await boucleAgent({
    question: "jeu",
    system: "s",
    maxPas: 3,
    generate: m.generate,
    executer: async () => "application écrite",
    verifier: async (c) =>
      c.type === "app_sans_erreur"
        ? { ok: false, observe: "1 erreur(s) console", erreur: "SyntaxError: Unexpected end of input", ms: 1500 }
        : { ok: false, observe: "exécution en erreur", erreur: "ReferenceError: score is not defined", ms: 3 },
    onAchevement: (e) => etats.push(e),
    journal: muet,
  });
  assert.ok(etats.length >= 3);
  assert.equal(etats[0].criteres.length, 2, "après le contrat : 2 critères, non vérifiés");
  assert.ok(etats[0].criteres.every((c) => c.etat === "non_verifie"));
  const apresApp = etats.find((e) => e.criteres.some((c) => c.etat === "echec"));
  assert.ok(apresApp, "après write_app : les critères sont vérifiés et en échec");
  assert.equal(apresApp.tronque, true, "la production coupée est visible dans l'état");
  assert.equal(resumeAchevement(r.achevement), "0/2 critères ✓ · pas 3/3 · non conclu · sortie tronquée");
  assert.equal(r.achevement.pasUtilises, 3);
});

/* ─── 6. Le modèle qui ment ───────────────────────────────────────────── */

test("P6 · le modèle déclare tout réussi alors que l'exécution échoue : done refusé, le mensonge nommé, l'erreur réelle renvoyée", async () => {
  const pasVus: PasAgent[] = [];
  const m = moteurScripte([
    CONTRAT_RUN,
    '<tool_call>{"name":"run_js","arguments":{}}</tool_call>',
    "function f(x){return x+x} f(2)",
    DONE_1,
    "f(2) = 4, c'est fait.",
  ]);
  const r = await boucleAgent({
    question: "f(2) = 4",
    system: "s",
    maxPas: 3,
    generate: m.generate,
    executer: async () => "→ 4",
    // Le harnais exécute LUI-MÊME f(2) : la vraie fonction rend 4… mais le
    // critère du contrat, exécuté par le harnais, ne trouve pas f (chaque
    // exécution est isolée) — c'est ce que l'exécution observe, pas ce que le
    // modèle raconte.
    verifier: async () => ({ ok: false, observe: "exécution en erreur", erreur: "ReferenceError: f is not defined", ms: 2 }),
    onPas: (p) => pasVus.push(p),
    journal: muet,
  });
  const done = pasVus.find((p) => p.outil === "done" && p.phase === "decision");
  assert.equal(done?.verdict, "refuse");
  assert.match(done?.resultat ?? "", /critère 1 déclaré réussi mais VU EN ÉCHEC par le harnais/);
  assert.match(done?.resultat ?? "", /ReferenceError: f is not defined/);
  assert.equal(r.termine, false, "on ne conclut pas sur la parole du modèle");
  assert.equal(r.achevement.conclu, false);
  assert.match(r.reponse, /0 critère sur 1 vérifié/);
  assert.match(r.reponse, /f is not defined/);
});

test("P6 · recouperDone nomme les mensonges et refuse aussi un critère échoué non déclaré", () => {
  const etats = etatsInitiaux([
    { type: "run_js", code: "f(2)", attendu: "4" },
    { type: "app_sans_erreur" },
  ]);
  etats[0] = { ...etats[0], etat: "echec", preuve: { ok: false, observe: "attendu « 4 », observé « 5 »", erreur: null, ms: 1 } };
  etats[1] = { ...etats[1], etat: "ok", preuve: { ok: true, observe: "chargée sans erreur console", erreur: null, ms: 1500 } };
  const menteur = recouperDone({ criteres_ok: [1, 2] }, etats);
  assert.equal(menteur.accepte, false);
  assert.deepEqual(menteur.mensonges, [1]);
  assert.match(menteur.motif, /critère 1 déclaré réussi mais VU EN ÉCHEC .* attendu « 4 », observé « 5 »/);
  const discret = recouperDone({ criteres_ok: [2] }, etats);
  assert.equal(discret.accepte, false, "un critère en échec bloque, déclaré ou pas");
  assert.match(discret.motif, /critère 1 en échec/);
  assert.match(recouperDone({ criteres_ok: [7] }, etats).motif, /critère\(s\) 7 : n'existe/);
});

/* ============================================================================
 * PYTHON — « il doit savoir le faire agir et me le montrer en fonctionnement »
 *
 * Ce que ces tests protègent : le jour où l'utilisateur demande un script
 * python, la preuve affichée doit être la SORTIE DU SCRIPT — pas la déclaration
 * du modèle. Et si aucun lanceur Python n'est disponible, le critère est
 * « non vérifié », jamais « réussi ».
 * ==========================================================================*/

test("Python · le critère « le script affiche 42 » est vérifié en LANÇANT le script", async () => {
  const lancements: string[] = [];
  const verifier = creerVerificateur({
    executerJs: async () => ({ ok: true, valeur: "4" }),
    executerPython: async (code: string) => {
      lancements.push(code);
      return { ok: true, valeur: "42" };
    },
  });

  const critere = validerCritere({ type: "run_python", code: "print(6*7)", attendu: "42" });
  assert.ok("critere" in critere, "un critère python avec code ET attendu est accepté");

  const preuve = await verifier(
    (critere as { critere: Critere }).critere,
    { html: null, reponse: null },
  );
  assert.equal(preuve.ok, true);
  assert.match(preuve.observe, /42/, "la preuve cite la SORTIE observée");
  assert.deepEqual(lancements, ["print(6*7)"], "le script a réellement été exécuté");
});

test("Python · une sortie différente de l'attendu est un ÉCHEC, chiffres à l'appui", async () => {
  const verifier = creerVerificateur({
    executerJs: async () => ({ ok: true, valeur: "4" }),
    executerPython: async () => ({ ok: true, valeur: "43" }),
  });
  const preuve = await verifier(
    { type: "run_python", code: "print(6*7+1)", attendu: "42" },
    { html: null, reponse: null },
  );
  assert.equal(preuve.ok, false, "43 n'est pas 42 : le critère n'est pas satisfait");
  assert.match(preuve.observe, /attendu « 42 »/, "l'attendu est cité");
  assert.match(preuve.observe, /43/, "l'observé est cité");
});

test("Python · un script qui plante rend l'erreur EXACTE, pas un « non »", async () => {
  const verifier = creerVerificateur({
    executerJs: async () => ({ ok: true, valeur: "4" }),
    executerPython: async () => ({
      ok: false,
      erreur: 'File "<exec>", line 2, in <module>\nNameError: name \'ctx\' is not defined',
    }),
  });
  const preuve = await verifier(
    { type: "run_python", code: "print(ctx)", attendu: "42" },
    { html: null, reponse: null },
  );
  assert.equal(preuve.ok, false);
  assert.match(preuve.erreur ?? "", /line 2/, "la ligne fautive remonte jusqu'à la preuve");
  assert.match(preuve.erreur ?? "", /NameError/, "la cause est conservée telle quelle");
});

test("Python · sans lanceur disponible, le critère est NON VÉRIFIÉ — jamais réussi", async () => {
  const verifier = creerVerificateur({ executerJs: async () => ({ ok: true, valeur: "4" }) });
  const preuve = await verifier(
    { type: "run_python", code: "print(42)", attendu: "42" },
    { html: null, reponse: null },
  );
  assert.equal(preuve.ok, false, "on ne déclare pas réussi ce qu'on n'a pas exécuté");
  assert.equal(preuve.nonVerifie, true);
  assert.match(preuve.observe, /aucun lanceur Python/, "on dit ce qui manque");
});

test("Python · un critère sans valeur attendue est REFUSÉ (une sortie non spécifiée ne prouve rien)", () => {
  const sansAttendu = validerCritere({ type: "run_python", code: "print(42)" });
  assert.ok("refus" in sansAttendu, "refusé");
  assert.match((sansAttendu as { refus: { raison: string } }).refus.raison, /AFFICHER/);

  const sansCode = validerCritere({ type: "run_python", attendu: "42" });
  assert.ok("refus" in sansCode, "refusé aussi");
});

test("Python · l'outil est déclaré, budgété et contraint par les grammaires", () => {
  assert.ok(
    OUTILS.some((o) => o.nom === "run_python"),
    "run_python est proposé au modèle",
  );
  assert.equal(BUDGETS.production.run_python, 800, "un script de 20 à 60 lignes ne doit pas être coupé à 400");
  assert.match(GRAMMAIRE_DECISION, /run_python/, "la décision contrainte connaît l'outil");
  assert.match(GRAMMAIRE_CONTRAT, /c-python/, "le contrat contraint accepte un critère python");
  // Le format d'appel reste UNIQUE : c'est lui que le modèle connaît.
  assert.match(GRAMMAIRE_DECISION, /<tool_call>/);
});
