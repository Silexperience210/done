/**
 * Tests du harnais : la boucle et l'analyse d'appel d'outil se vérifient SANS
 * navigateur ni modèle — c'est tout l'intérêt d'avoir injecté `generate` et
 * `executer`. Ce qu'on protège ici :
 *  - le format d'appel reste tolérant à la forme mais strict sur le fond (un
 *    outil inconnu ne doit JAMAIS être exécuté) ;
 *  - la boucle s'arrête sur `done`, sur du texte, ou au plafond ;
 *  - une erreur d'outil est renvoyée au modèle au lieu d'interrompre la tâche.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyserAppel,
  boucleAgent,
  ecrireMemoire,
  OUTILS,
  type Outil,
} from "./agent.ts";

test("analyse un appel d'outil balisé", () => {
  const out = analyserAppel('Je calcule.\n```tool\n{"name": "run_js", "args": {"code": "2+2"}}\n```');
  assert.deepEqual(out, { nom: "run_js", args: { code: "2+2" } });
});

test("tolère une virgule finale et du texte autour", () => {
  const out = analyserAppel('Voilà :\n```json\n{"name": "remember", "args": {"note": "ok"},}\n```\nVoilà.');
  assert.deepEqual(out, { nom: "remember", args: { note: "ok" } });
});

test("refuse un outil INCONNU (aucune exécution devinée)", () => {
  assert.equal(analyserAppel('```tool\n{"name": "shell", "args": {"cmd": "rm -rf /"}}\n```'), null);
});

test("renvoie null sur une réponse en texte normal", () => {
  assert.equal(analyserAppel("Bonjour, voici la réponse."), null);
  assert.equal(analyserAppel("```js\nconsole.log(1)\n```"), null);
});

test("accepte un objet JSON nu sans clôture", () => {
  const out = analyserAppel('{"name": "run_js", "args": {"code": "1"}}');
  assert.deepEqual(out, { nom: "run_js", args: { code: "1" } });
});

test("une réponse en texte termine la boucle en un pas", async () => {
  const r = await boucleAgent({
    question: "dis bonjour",
    system: "test",
    generate: async () => "Bonjour !",
    executer: async () => {
      throw new Error("aucun outil ne doit être exécuté");
    },
  });
  assert.equal(r.termine, true);
  assert.equal(r.etapes.length, 0);
  assert.equal(r.reponse, "Bonjour !");
});

test("enchaîne un outil puis done", async () => {
  const vus: string[] = [];
  let tour = 0;
  const r = await boucleAgent({
    question: "calcule",
    system: "test",
    generate: async () => {
      tour += 1;
      return tour === 1
        ? '```tool\n{"name": "run_js", "args": {"code": "2+2"}}\n```'
        : '```tool\n{"name": "done", "args": {"summary": "4"}}\n```';
    },
    executer: async (o: Outil) => {
      vus.push(o.nom);
      return "→ 4";
    },
  });
  assert.deepEqual(vus, ["run_js"]);
  assert.equal(r.etapes.length, 1);
  assert.equal(r.termine, true);
  assert.equal(r.reponse, "4");
});

test("s'arrête au plafond de pas au lieu de boucler sans fin", async () => {
  const r = await boucleAgent({
    question: "boucle",
    system: "test",
    maxPas: 3,
    generate: async () => '```tool\n{"name": "run_js", "args": {"code": "1"}}\n```',
    executer: async () => "→ 1",
  });
  assert.equal(r.etapes.length, 3);
  assert.equal(r.plafondAtteint, true);
  assert.equal(r.termine, false);
});

test("une erreur d'outil est renvoyée au modèle, pas fatale", async () => {
  let tour = 0;
  const r = await boucleAgent({
    question: "échoue puis conclut",
    system: "test",
    generate: async () => {
      tour += 1;
      return tour === 1
        ? '```tool\n{"name": "run_js", "args": {"code": "("}}\n```'
        : '```tool\n{"name": "done", "args": {"summary": "corrigé"}}\n```';
    },
    executer: async () => {
      throw new Error("SyntaxError");
    },
  });
  assert.equal(r.etapes[0].resultat, "erreur d'exécution : SyntaxError");
  assert.equal(r.reponse, "corrigé");
  assert.equal(r.termine, true);
});

test("un appel mal formé est REDEMANDÉ, pas pris pour une réponse finale", async () => {
  let tour = 0;
  const r = await boucleAgent({
    question: "écris une appli",
    system: "test",
    generate: async () => {
      tour += 1;
      if (tour === 1) return 'Je vais le faire.\n```tool\n{"name": "write_app", "args": {"title": "X"}\n```';
      if (tour === 2) return '```tool\n{"name": "done", "args": {"summary": "fait"}}\n```';
      return "?";
    },
    executer: async () => "ok",
  });
  assert.equal(tour, 2, "la boucle a redemandé au lieu de s'arrêter");
  assert.equal(r.termine, true);
  assert.equal(r.reponse, "fait");
});

test("une vraie réponse en texte reste terminale (pas de relance inutile)", async () => {
  let tour = 0;
  const r = await boucleAgent({
    question: "bonjour",
    system: "test",
    generate: async () => {
      tour += 1;
      return "Bonjour, comment puis-je aider ?";
    },
    executer: async () => "ok",
  });
  assert.equal(tour, 1);
  assert.equal(r.reponse, "Bonjour, comment puis-je aider ?");
});

test("la mémoire est bornée (volume et nombre)", () => {
  const grosses = Array.from({ length: 60 }, (_, i) => `note ${i} `.repeat(20));
  const gardees = ecrireMemoire(grosses);
  assert.ok(gardees.length >= 1, "au moins une note conservée");
  assert.ok(gardees.join("\n").length <= 1800, `volume borné (${gardees.join("\n").length})`);
  assert.ok(gardees.length <= 24, "nombre borné");
  assert.ok(gardees[gardees.length - 1].includes("note 59"), "les plus récentes sont gardées");
});

test("chaque outil déclaré a un nom unique et une description", () => {
  const noms = OUTILS.map((o) => o.nom);
  assert.equal(new Set(noms).size, noms.length);
  for (const o of OUTILS) assert.ok(o.description.length > 10, `${o.nom} décrit`);
});
