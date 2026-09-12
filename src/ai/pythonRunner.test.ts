/**
 * Vérification du lanceur PYTHON, hors appareil et sans WebAssembly.
 *
 * POURQUOI CE TEST EXISTE : le jour où l'utilisateur écrira « fais-moi un script
 * python », la seule chose qui compte est que la sortie affichée soit CELLE DU
 * SCRIPT — pas une reformulation, pas un vide présenté comme un succès. On
 * simule donc Pyodide pour vérifier le contrat : capture de la sortie, erreur
 * exacte, chargement unique, échec propre et réessayable, et surtout : rien n'est
 * exécuté quand Python n'a pas démarré.
 *
 * Le vrai chargement de Pyodide (12,3 Mo de WebAssembly) ne se teste qu'à l'œil
 * sur téléphone : il est dit tel quel dans le rapport, jamais présenté comme
 * vérifié.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  creerExecuteurPython,
  lireManifestePyodide,
  tailleEmbarquee,
  type Pyodide,
} from "./pythonRunner.ts";

/** Pyodide simulé : il note le code reçu, écrit ce qu'on lui demande. */
function fauxPyodide(options: {
  sortie?: string[];
  erreurs?: string[];
  leve?: string;
  version?: string;
  versionPython?: string;
} = {}) {
  const executions: string[] = [];
  let surSortie: ((t: string) => void) | null = null;
  let surErreur: ((t: string) => void) | null = null;
  const instance: Pyodide = {
    version: options.version ?? "0.29.4",
    setStdout: ({ batched }) => {
      surSortie = batched;
    },
    setStderr: ({ batched }) => {
      surErreur = batched;
    },
    runPythonAsync: async (code: string) => {
      executions.push(code);
      if (code.startsWith("import sys")) return options.versionPython ?? "3.13.2";
      for (const l of options.sortie ?? []) surSortie?.(l + "\n");
      for (const l of options.erreurs ?? []) surErreur?.(l + "\n");
      if (options.leve) throw new Error(options.leve);
      return undefined;
    },
  };
  return { instance, executions };
}

test("la sortie du script est capturée ligne par ligne, et la durée est mesurée", async () => {
  const faux = fauxPyodide({ sortie: ["Bonjour", "42"], versionPython: "3.13.2" });
  // Horloge en escalier : l'exécution lit l'heure AU DÉBUT puis À LA FIN, donc
  // deux lectures — 1000 ms puis 1042 ms, soit 42 ms de durée mesurée.
  const heures = [1000, 1042];
  let i = 0;
  const executer = creerExecuteurPython({ charger: async () => faux.instance, maintenant: () => heures[Math.min(i++, heures.length - 1)] });

  const r = await executer("print('Bonjour')\nprint(6*7)");

  assert.equal(r.ok, true);
  assert.equal(r.erreur, null);
  assert.equal(r.sortie, "Bonjour\n42", "les deux lignes, dans l'ordre, sans retour chariot parasite");
  assert.equal(r.ms, 42, "durée réelle de l'horloge injectée");
  assert.equal(r.premierAppel, true, "le premier appel porte le chargement");
  assert.ok(faux.executions.some((c) => c.includes("print('Bonjour')")), "le code a bien été transmis à Python");

  const r2 = await executer("print(1)");
  assert.equal(r2.premierAppel, false, "le deuxième appel ne recharge pas Python");
});

test("une erreur Python est reprise TELLE QUELLE, avec la ligne, et la sortie partielle est gardée", async () => {
  const faux = fauxPyodide({
    sortie: ["début"],
    leve: 'Traceback (most recent call last):\n  File "<exec>", line 2, in <module>\nNameError: name \'ctx\' is not defined',
  });
  const executer = creerExecuteurPython({ charger: async () => faux.instance });

  const r = await executer("print('début')\nprint(ctx)");

  assert.equal(r.ok, false, "un script qui casse n'est PAS un succès");
  assert.match(r.erreur ?? "", /File "<exec>", line 2/, "le numéro de ligne est conservé");
  assert.match(r.erreur ?? "", /NameError/, "la cause exacte est conservée");
  assert.equal(r.sortie, "début", "ce qui a été écrit avant l'erreur reste visible");
});

test("le chargement n'a lieu QU'UNE fois, et un échec reste réessayable", async () => {
  let chargements = 0;
  const faux = fauxPyodide({ sortie: ["ok"] });
  const executer = creerExecuteurPython({
    charger: async () => {
      chargements += 1;
      if (chargements === 1) throw new Error("mémoire insuffisante");
      return faux.instance;
    },
  });

  const echec = await executer("print(1)");
  assert.equal(echec.ok, false);
  assert.match(echec.erreur ?? "", /mémoire insuffisante/, "la cause du chargement est dite");
  assert.deepEqual(faux.executions, [], "AUCUN code n'est exécuté quand Python n'a pas démarré");

  const reussite = await executer("print(1)");
  assert.equal(reussite.ok, true, "un second essai doit pouvoir aboutir");
  assert.equal(chargements, 2, "le premier échec n'a pas condamné la session");

  await executer("print(2)");
  assert.equal(chargements, 2, "une fois chargé, on ne recharge plus");
});

test("un chargement qui ne rend jamais la main est dit, avec les secondes écoulées", async () => {
  const executer = creerExecuteurPython({
    charger: () => new Promise<Pyodide>(() => {}),
    delaiChargementMs: 30,
  });

  const r = await executer("print(1)");
  assert.equal(r.ok, false);
  assert.match(r.erreur ?? "", /n'a pas fini de se charger/, "on nomme l'attente");
  assert.match(r.erreur ?? "", /mémoire/, "on donne la piste utile");
});

test("les avertissements (stderr) sont visibles dans la sortie affichée", async () => {
  const faux = fauxPyodide({ sortie: ["résultat : 4"], erreurs: ["avertissement : chose dépréciée"] });
  const executer = creerExecuteurPython({ charger: async () => faux.instance });

  const r = await executer("...");
  assert.equal(r.ok, true);
  assert.match(r.sortie, /résultat : 4/);
  assert.match(r.sortie, /avertissement/, "ce que le script dit sur stderr n'est pas jeté");
});

test("l'état expose les versions RÉELLES une fois chargé", async () => {
  const faux = fauxPyodide({ version: "0.29.4", versionPython: "3.13.2" });
  const executer = creerExecuteurPython({ charger: async () => faux.instance });

  assert.deepEqual(executer.etat(), { charge: false, versionPyodide: null, versionPython: null, erreur: null });
  await executer("print(1)");
  assert.equal(executer.etat().charge, true);
  assert.equal(executer.etat().versionPyodide, "0.29.4");
  assert.equal(executer.etat().versionPython, "3.13.2");
});

test("le manifeste donne la taille RÉELLE embarquée, et `null` s'il manque", async () => {
  const manifeste = {
    pyodide: "0.29.4",
    python: "3.13.2",
    total: 12_285_651,
    paquetsEmbarques: [] as string[],
    fichiers: [{ nom: "pyodide.asm.wasm", octets: 8_647_684 }],
  };
  const avec = await lireManifestePyodide(
    (async () => new Response(JSON.stringify(manifeste), { status: 200 })) as unknown as typeof fetch,
  );
  assert.equal(avec?.python, "3.13.2");
  assert.equal(tailleEmbarquee(avec), "12,3 Mo", "taille mesurée, formatée pour l'écran");
  assert.deepEqual(avec?.paquetsEmbarques, [], "on dit ce qui n'est PAS embarqué");

  const absent = await lireManifestePyodide(
    (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
  );
  assert.equal(absent, null);
  assert.equal(tailleEmbarquee(null), null, "pas de manifeste : pas de chiffre, jamais un chiffre inventé");
});
