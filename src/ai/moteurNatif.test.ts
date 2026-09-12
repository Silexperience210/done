/**
 * Tests du moteur natif — sans Android et sans llama.cpp.
 *
 * Ce qui est protégé ici, parce que c'est ce qui a coûté cher en vrai :
 *  - le streaming remonte bien jeton par jeton (sinon pas d'effet de frappe) ;
 *  - LE DÉBIT AFFICHÉ EST RÉELLEMENT MESURABLE SUR ANDROID. C'était le défaut :
 *    la mesure attendue (`timings.predicted_per_second`) n'existe PAS côté
 *    Android — `jni.cpp:986-997` ne remplit `timings` qu'avec `prompt_n` et
 *    `predicted_n` — donc l'écran restait à « 0.0 tok/s » alors que le moteur
 *    tournait. Le simulacre ci-dessous reproduit donc la forme RÉELLE d'Android,
 *    et le débit est un COMPTE DE JETONS RÉEL ÷ une fenêtre de décodage MESURÉE,
 *    jamais une estimation tirée d'une longueur de texte ;
 *  - AUCUN PARAMÈTRE DE GPU n'est envoyé : le binaire du plugin ne contient
 *    aucun backend GPU, donc `n_gpu_layers` ne déplace rien (llama-model.cpp
 *    met `act_gpu_layers = 0` quand la liste de devices est vide). L'envoyer
 *    promettait un gain qui n'existe pas ;
 *  - LE NOMBRE DE THREADS EST RÉGLABLE, ET IL EST RÉGLÉ : le natif lit bien
 *    `n_threads` (second patch, `patches/llama-cpp-capacitor+0.1.5+001+threads.patch`),
 *    et la valeur vient de `nbThreadsCalcul()` — la moitié des processeurs
 *    logiques, bornée à [1, 6] — pour ne pas jeter des threads sur les petits
 *    cœurs d'un big.LITTLE, où ggml les attendrait à la barrière de fin d'étape ;
 *  - les méthodes de session (`saveSession`/`loadSession`) ne sont JAMAIS
 *    appelées : dans la version installée elles font « rien » en répondant un
 *    succès (LlamaCpp.java:801-823). C'était un cache mensonger ;
 *  - le texte rendu par le moteur n'est PAS reformaté, pour que la
 *    réutilisation du préfixe (cap-completion.cpp:178) reste possible au pas
 *    suivant ; le nettoyage d'affichage vit à part (`nettoyerPourAffichage`) ;
 *  - libérer l'ancien modèle avant d'en charger un autre (sinon la RAM explose
 *    sur un téléphone) ;
 *  - le modèle se désigne par le NOM DE FICHIER SEUL (le plugin le résout dans
 *    ses dossiers, dont getFilesDir()/Documents) et AUCUN `is_model_asset` n'est
 *    transmis : ce paramètre n'est lu nulle part côté Android (vérifié dans
 *    LlamaCpp.java), l'envoyer trompait sur sa prise en charge ;
 *  - le quant du 30B tient dans la RAM du téléphone (8,005 Go, pas 8,914).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  creerMoteurNatif,
  debitMesure,
  modeleGguf,
  MODELES_GGUF,
  nbThreadsCalcul,
  nettoyerPourAffichage,
  type PluginLlama,
} from "./moteurNatif.ts";

/**
 * Plugin SIMULÉ, calqué sur ce que le natif ANDROID rend VRAIMENT — pas sur la
 * forme rêvée des définitions TypeScript, qui décrivent l'union Android+iOS.
 *
 * Sur Android (`jni.cpp:986-997`), `timings` ne porte que `prompt_n` et
 * `predicted_n` : il n'y a NI `predicted_per_second`, NI `predicted_ms`. Le
 * compte de jetons, lui, est RÉEL (`tokens_predicted`, jni.cpp:948). Un
 * simulacre qui offrait `predicted_per_second` faisait passer les tests au vert
 * sur une forme que la plateforme de production ne produit jamais.
 */
function pluginFactice(
  journal: Record<string, unknown>[],
  reponse?: {
    text?: string;
    /** Compte de jetons RÉEL rendu par le moteur (défaut : 120). */
    jetons?: number;
    /** Débit fourni par le moteur — présent seulement sur iOS / future version. */
    debitsMoteur?: number;
  },
) {
  const jetons = reponse?.jetons ?? 120;
  const plugin: PluginLlama = {
    initLlama: async (p) => {
      journal.push(p);
      return { id: "contexte" };
    },
    completion: async (p, cb) => {
      journal.push(p);
      for (const t of ["Bon", "jour"]) cb?.({ token: t });
      return {
        text: reponse?.text ?? "Bonjour",
        tokens_predicted: jetons,
        timings: {
          prompt_n: 42,
          predicted_n: jetons,
          ...(reponse?.debitsMoteur === undefined
            ? {}
            : { predicted_per_second: reponse.debitsMoteur }),
        },
      };
    },
    releaseAllLlama: async () => {
      journal.push({ libere: true });
    },
  };
  return async () => plugin;
}

/**
 * Horloge injectée : rend les valeurs fournies, dans l'ordre, puis répète la
 * dernière. Permet de VÉRIFIER la mesure du débit sans temps réel.
 */
function horlogeValeurs(valeurs: number[]): () => number {
  let i = 0;
  return () => valeurs[Math.min(i++, valeurs.length - 1)];
}

const base = {
  cheminModele: (m: { fichier: string }) => `/data/models/${m.fichier}`,
};

test("on n'envoie QUE les paramètres que le JNI lit vraiment, sans rien pour le GPU", async () => {
  // Lu dans jni.cpp, version installée PUIS patchée (0.1.5 +
  // patches/llama-cpp-capacitor+0.1.5+001+threads.patch) : le natif consomme
  // `n_ctx`, `n_batch`, `n_gpu_layers`, `n_threads` (ajouté par le patch),
  // `use_mmap`, `use_mlock` et `embedding`.
  // `n_gpu_layers` est justement celui qu'on n'envoie PLUS : le .so ne contient
  // ni backend OpenCL ni backend Vulkan, et llama-model.cpp force
  // `act_gpu_layers = 0` sur une liste de devices vide. `n_ubatch` n'est
  // toujours pas lu par le JNI, et n'est donc pas envoyé.
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder15");
  const init = journal[0];
  assert.equal(init.n_ctx, 4096, "4096 : la boucle d'agent a besoin de place");
  assert.equal(init.n_batch, 512, "lot de pré-remplissage");
  assert.equal(init.use_mmap, false, "sans mmap : plus rapide jusqu'au premier jeton");
  assert.equal(init.use_mlock, false);
  assert.ok(!("n_gpu_layers" in init), "aucun déport GPU : le binaire n'a aucun backend GPU");
  // Le patch AJOUTE `n_threads` au lecteur JNI : la valeur part, et c'est un
  // entier (le JNI l'extrait avec `intValue()`, jni.cpp).
  assert.ok("n_threads" in init, "n_threads est transmis : le JNI le lit depuis le patch threads");
  assert.equal(
    init.n_threads,
    nbThreadsCalcul(),
    "la valeur transmise est celle du calcul big.LITTLE, pas une constante",
  );
  assert.ok(Number.isInteger(init.n_threads), "entier : le JNI appelle Integer.intValue()");
  assert.ok(!("n_ubatch" in init), "n_ubatch n'est pas lu par le JNI non plus");
  assert.ok(String(init.model).endsWith("Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf"));
  assert.equal(m.pret(), true);
});

test("nbThreadsCalcul : la taille du cluster de performance, jamais tous les cœurs", () => {
  // `hardwareConcurrency` compte les processeurs LOGIQUES. Sur un big.LITTLE,
  // demander ce total revient à garantir que des threads tournent sur les petits
  // cœurs — et ggml attend tous ses threads à la barrière de fin d'étape.
  assert.equal(nbThreadsCalcul(8), 4, "8 cœurs (1+3+4, 4+4, 2+6) : la moitié, PAS les 8");
  assert.equal(nbThreadsCalcul(6), 3, "6 cœurs : la moitié");
  assert.equal(nbThreadsCalcul(12), 6, "12 cœurs : la moitié, plafonnée à 6");
  assert.equal(nbThreadsCalcul(16), 6, "au-delà : toujours 6, pour garder l'UI réactive");
  assert.equal(nbThreadsCalcul(4), 4, "4 cœurs : pas de petite grappe à isoler");
  assert.equal(nbThreadsCalcul(2), 2);
  assert.equal(nbThreadsCalcul(1), 1, "jamais 0 : ggml le relirait comme la constante 4");
  assert.equal(nbThreadsCalcul(0), 4, "valeur absurde -> repli sûr");
  assert.equal(nbThreadsCalcul(Number.NaN), 4, "valeur absurde -> repli sûr");
  assert.equal(nbThreadsCalcul(7.9), 3, "arrondi vers le bas, pas de 0,5 thread");
  // La propriété qui compte, énoncée telle quelle :
  for (const logiques of [8, 9, 10, 12, 16]) {
    assert.ok(
      nbThreadsCalcul(logiques) < logiques,
      `${logiques} cœurs : on ne demande jamais tous les cœurs`,
    );
  }
  // Et le défaut, sans argument, se lit sur la machine — jamais une constante :
  assert.equal(nbThreadsCalcul(), nbThreadsCalcul(navigator.hardwareConcurrency));
});

test("nThreads permet de forcer une autre valeur (mesure sur appareil)", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, nThreads: 3, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder15");
  assert.equal(journal[0].n_threads, 3, "la surcharge passe telle quelle");
  assert.notEqual(nbThreadsCalcul(), 3, "et elle est bien distincte du défaut ici");
});

test("n_ctx et le lot de pré-remplissage sont configurables", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({
    ...base,
    nCtx: 8192,
    nBatch: 1024,
    chargerPlugin: pluginFactice(journal),
  });
  await m.charger("coder15");
  assert.equal(journal[0].n_ctx, 8192);
  assert.equal(journal[0].n_batch, 1024);
});

test("le NOM DE FICHIER SEUL est transmis (résolu par les dossiers du plugin)", async () => {
  // Le GGUF est téléchargé dans getFilesDir()/Documents/<fichier> par
  // modeleLocal.ts. Le plugin Android ne retient que le nom de fichier
  // (`new File(modelPath).getName()`) et le cherche dans ses propres dossiers :
  // on lui passe donc le nom seul, exactement ce que fait cheminModele(id).
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({
    ...base,
    cheminModele: (mod) => mod.fichier,
    chargerPlugin: pluginFactice(journal),
  });
  await m.charger("coder05");
  assert.equal(
    journal[0].model,
    "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
    "le nom de fichier seul, sans dossier",
  );
});

test("aucun is_model_asset n'est transmis : le plugin Android l'ignore", async () => {
  // Vérifié dans LlamaCpp.java : `is_model_asset` n'est lu nulle part côté
  // Android. L'envoyer laissait croire qu'il activait la recherche dans les
  // assets, ce qui n'existe pas — c'était la cause de l'échec de chargement.
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder05");
  assert.ok(!("is_model_asset" in journal[0]), "le drapeau ignoré ne doit plus partir");
});

test("avec un chemin complet, on passe ce chemin tel quel", async () => {
  // Le moteur ne présume pas de l'emplacement : il transmet ce que lui donne
  // `cheminModele`. Le nom seul est le cas réel (voir modeleLocal.ts).
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginFactice(journal) });
  await m.charger("coder05");
  assert.ok(String(journal[0].model).startsWith("/data/models/"), "le chemin fourni est transmis");
});

test("chaque modèle sait d'où venir et quelle taille attendre", () => {
  // Un modèle sans URL ne serait pas téléchargeable : le champ est obligatoire.
  // `octets` doit rester cohérent avec `tailleGo` (relevés sur le Hub).
  for (const modele of MODELES_GGUF) {
    assert.match(
      modele.url,
      /^https:\/\/huggingface\.co\/.+\/resolve\/main\/.+\.gguf$/,
      `${modele.id} : URL directe vers le GGUF`,
    );
    const octetsParGo = modele.octets / modele.tailleGo;
    assert.ok(
      octetsParGo > 0.95e9 && octetsParGo < 1.05e9,
      `${modele.id} : octets cohérent avec tailleGo (${modele.octets} / ${modele.tailleGo})`,
    );
    assert.ok(
      modele.url.endsWith(modele.fichier),
      `${modele.id} : l'URL pointe bien sur le fichier annoncé`,
    );
  }
});

test("les jetons arrivent un par un et le débit est mesuré sur le COMPTE RÉEL de jetons", async () => {
  // Forme RÉELLE d'Android : aucun `predicted_per_second`, seulement le compte
  // de jetons. Le débit vaut donc jetons réels ÷ fenêtre de décodage mesurée :
  // 120 jetons en 5000 ms ⇒ 24 tok/s. Avec l'ancien code, ce cas rendait `null`
  // et l'écran affichait « 0.0 tok/s » pendant que le moteur tournait.
  const m = creerMoteurNatif({
    ...base,
    // Horloge : début à 0, premier jeton à 1000 ms, fin à 6000 ms.
    maintenant: horlogeValeurs([0, 1000, 6000]),
    chargerPlugin: pluginFactice([], { text: "Bonjour", jetons: 120 }),
  });
  await m.charger("coder15");
  const vus: string[] = [];
  const mesures: { v: number; j: number; ms: number }[] = [];
  const texte = await m.generer({
    system: "test",
    history: [{ role: "user", content: "salut" }],
    onToken: (t) => vus.push(t),
    onVitesse: (v, j, ms) => mesures.push({ v, j, ms }),
  });
  assert.deepEqual(vus, ["Bon", "jour"], "streaming jeton par jeton");
  assert.equal(texte, "Bonjour");
  assert.equal(mesures.length, 1, "une seule mesure, à la fin de la génération");
  assert.equal(mesures[0].j, 120, "compte de jetons RÉEL rendu par le moteur");
  assert.equal(mesures[0].v, 24, "120 jetons / 5 s de décodage");
  assert.equal(mesures[0].ms, 5000, "durée de la fenêtre de décodage");
  assert.equal(m.derniereVitesse(), 24);
});

test("quand le moteur fournit son propre débit, il est pris TEL QUEL", async () => {
  // Cas iOS (et future version Android) : `predicted_per_second` existe. La
  // mesure du moteur prime sur tout calcul local — l'horloge injectée est
  // volontairement absurde (999 s) : si le code s'en servait, le résultat ne
  // serait pas 21,3.
  const m = creerMoteurNatif({
    ...base,
    maintenant: horlogeValeurs([0, 1000, 999_000]),
    chargerPlugin: pluginFactice([], { jetons: 120, debitsMoteur: 21.3 }),
  });
  await m.charger("coder15");
  const mesures: number[] = [];
  await m.generer({ system: "s", history: [], onVitesse: (v) => mesures.push(v) });
  assert.deepEqual(mesures, [21.3], "le débit du moteur passe sans retouche");
  assert.equal(m.derniereVitesse(), 21.3);
});

test("le débit mesuré suit le modèle et la dernière génération, pour les trois modèles", async () => {
  // L'affichage ne dépend d'AUCUN moteur en particulier : il ne connaît que
  // « un compte de jetons et une durée ». On le vérifie sur les trois modèles
  // du sélecteur, avec une valeur différente à chaque fois.
  for (const id of ["coder05", "coder15", "coder3b"] as const) {
    const m = creerMoteurNatif({
      ...base,
      maintenant: horlogeValeurs([0, 2000, 4000]),
      chargerPlugin: pluginFactice([], { jetons: 60 }),
    });
    await m.charger(id);
    assert.equal(m.derniereVitesse(), null, `${id} : rien de mesuré avant toute génération`);
    await m.generer({ system: "s", history: [] });
    assert.equal(m.derniereVitesse(), 30, `${id} : 60 jetons / 2 s = 30 tok/s`);
  }
});

test("sans compte de jetons ni débit, aucun chiffre n'est fabriqué", async () => {
  // Plugin muet sur les mesures : aucun `timings`, aucun `tokens_predicted`.
  // On ne PEUT pas mesurer honnêtement, donc `derniereVitesse()` reste `null` et
  // `onVitesse` n'est pas appelé — l'interface écrira « — ». C'est ce qui
  // distingue « pas de mesure » d'un « 0,0 tok/s » qui se lit comme un résultat.
  const plugin: PluginLlama = {
    initLlama: async () => ({ id: "contexte" }),
    completion: async (_p, cb) => {
      for (const t of ["a", "b"]) cb?.({ token: t });
      return { text: "ab" };
    },
  };
  const m = creerMoteurNatif({ ...base, chargerPlugin: async () => plugin });
  await m.charger("coder15");
  const mesures: number[] = [];
  await m.generer({ system: "s", history: [], onVitesse: (v) => mesures.push(v) });
  assert.deepEqual(mesures, [], "aucune mesure inventée");
  assert.equal(m.derniereVitesse(), null, "pas de mesure : null, jamais 0");
});

test("debitMesure : le compte de jetons et la fenêtre de décodage, rien d'autre", () => {
  // 1) Cas ANDROID type : jetons réels, pas de durée fournie par le moteur.
  assert.deepEqual(
    debitMesure(
      { tokens_predicted: 200, timings: { prompt_n: 30, predicted_n: 200 } },
      { msDepuisPremierJeton: 5000, msTotal: 9000 },
    ),
    { tokParSeconde: 40, jetons: 200, msDepuisPremier: 5000 },
    "200 jetons / 5 s : le pré-remplissage (9000 ms au total) n'est PAS compté",
  );
  // 2) La durée du moteur prime sur la nôtre quand elle existe.
  assert.deepEqual(
    debitMesure(
      { timings: { predicted_n: 100, predicted_ms: 2000 } },
      { msDepuisPremierJeton: 9000, msTotal: 12_000 },
    ),
    { tokParSeconde: 50, jetons: 100, msDepuisPremier: 2000 },
  );
  // 3) Aucun premier jeton observé : repli sur la durée totale de l'appel, qui
  //    inclut le pré-remplissage — on sous-estime plutôt que de surestimer.
  assert.deepEqual(
    debitMesure({ tokens_predicted: 40 }, { msDepuisPremierJeton: 0, msTotal: 4000 }),
    { tokParSeconde: 10, jetons: 40, msDepuisPremier: 4000 },
  );
  // 4) Le débit du moteur gagne, même sans compte de jetons.
  assert.deepEqual(
    debitMesure({ timings: { predicted_per_second: 12.5 } }, { msDepuisPremierJeton: 8000, msTotal: 8000 }),
    { tokParSeconde: 12.5, jetons: 0, msDepuisPremier: 8000 },
  );
  // 5) Rien d'exploitable : `null`, et surtout pas 0.
  assert.equal(debitMesure(undefined, { msDepuisPremierJeton: 0, msTotal: 0 }), null);
  assert.equal(debitMesure({}, { msDepuisPremierJeton: 5000, msTotal: 5000 }), null, "des jetons, mais aucune durée");
  assert.equal(debitMesure({ tokens_predicted: 10 }, { msDepuisPremierJeton: 0, msTotal: 0 }), null, "une durée nulle n'est pas une mesure");
  // 6) Valeurs absurdes (0, NaN, négatives) : ignorées, jamais propagées.
  assert.equal(
    debitMesure(
      { tokens_predicted: Number.NaN, timings: { predicted_n: 0, predicted_per_second: 0 } },
      { msDepuisPremierJeton: -1, msTotal: 0 },
    ),
    null,
  );
});

test("le texte rendu est celui du moteur, NON reformaté", async () => {
  // Un `.trim()` (ou un `.replace()`) ici suffirait à faire diverger le préfixe
  // que le natif compare jeton par jeton au pas suivant.
  const brut = "  Bonjour\n";
  const plugin: PluginLlama = {
    initLlama: async () => ({ id: "contexte" }),
    completion: async (_p, cb) => {
      for (const t of ["  ", "Bonjour", "\n"]) cb?.({ token: t });
      return { text: brut, timings: { predicted_n: 3 } };
    },
  };
  const m = creerMoteurNatif({ ...base, chargerPlugin: async () => plugin });
  await m.charger("coder15");
  const rendu = await m.generer({ system: "S", history: [] });
  assert.equal(rendu, brut, "rendu brut : ni trim, ni retrait de balise");
});

test("un appelant qui réinjecte le texte rendu conserve TOUT le préfixe déjà évalué", async () => {
  // Simule ce que fait le natif à chaque appel (cap-completion.cpp:178) : `embd`
  // = jetons du prompt précédent PUIS les jetons générés, et le nouveau prompt
  // est comparé jeton par jeton à cette suite — tout ce qui coïncide n'est pas
  // réévalué. On tokenise caractère par caractère : la propriété testée (le
  // texte réinjecté doit être IDENTIQUE, à tel point qu'il ne reformate rien) ne
  // dépend pas du découpage, et elle devient vérifiable ici sans téléphone.
  const journal: Record<string, unknown>[] = [];
  const jetonsGeneres = ["B", "o", "n", "j", "o", "u", "r", "\n"];
  const tokeniser = (t: string): string[] => [...t];
  let embd: string[] = [];
  const reutilise: number[] = [];
  const plugin: PluginLlama = {
    initLlama: async () => ({ id: "contexte" }),
    completion: async (p, cb) => {
      journal.push(p);
      const jetons = tokeniser(String(p.prompt));
      let nPast = 0;
      while (nPast < Math.min(embd.length, jetons.length) && embd[nPast] === jetons[nPast]) nPast++;
      reutilise.push(nPast);
      embd = jetons; // le natif remplace embd…
      for (const t of jetonsGeneres) {
        cb?.({ token: t });
        embd.push(t); // …puis y ajoute ce qu'il vient de générer
      }
      return { text: jetonsGeneres.join(""), timings: { predicted_per_second: 9 } };
    },
  };
  const m = creerMoteurNatif({ ...base, chargerPlugin: async () => plugin });
  await m.charger("coder15");

  const premier = await m.generer({ system: "S", history: [{ role: "user", content: "q1" }] });
  assert.equal(premier, "Bonjour\n", "rendu tel quel, espaces et saut de ligne compris");
  const jetonsPrompt1 = tokeniser(String(journal[0].prompt));

  await m.generer({
    system: "S",
    history: [
      { role: "user", content: "q1" },
      // Réinjection TELLE QUELLE : c'est ce que fait un appelant qui garde la
      // conversation. Un `.trim()` (ou un retrait de balise) suffirait à faire
      // diverger la comparaison, donc à recalculer la fin de la génération.
      { role: "assistant", content: premier },
      { role: "user", content: "q2" },
    ],
  });

  assert.deepEqual(
    reutilise,
    [0, jetonsPrompt1.length + jetonsGeneres.length],
    "au 2e pas, TOUT était déjà évalué : rien à recalculer",
  );
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

test("le 30B-A3B pointe sur le quant UD-TQ1_0 réel du dépôt Hub (8,005 Go)", () => {
  const gros = modeleGguf("coder3b");
  // Nom exact et taille exacte relevés sur l'API du Hub : 8 005 213 344 octets.
  // IQ1_S faisait 8,914 Go : avec la KV (4096 jetons), les buffers et l'OS, on
  // sortait des 12 Go de l'appareil — un débordement, pas une lenteur.
  assert.equal(gros.fichier, "Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf");
  assert.equal(gros.tailleGo, 8.005);
  assert.equal(gros.octets, 8_005_213_344);
  assert.ok(!gros.fichier.includes("IQ1_S"), "le quant qui débordait est retiré");
  assert.ok(gros.nom.includes("TQ1_0"));
  // Et il tient sous les 8,1 Go qu'on s'autorise sur douze.
  assert.ok(gros.octets / 1e9 < 8.1, "le 30B reste sous la limite mémoire visée");
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

/**
 * Plugin qui expose EN PLUS les méthodes de session. On les garde ici pour
 * prouver qu'elles ne sont jamais appelées : dans llama-cpp-capacitor 0.1.5,
 * `LlamaCpp.java:801-823` les implémente en ne faisant rien (aucune E/S, aucun
 * appel JNI) et répond pourtant un succès.
 */
function pluginAvecSession(journal: Record<string, unknown>[]): () => Promise<PluginLlama> {
  const plugin = {
    initLlama: async (p: Record<string, unknown>) => {
      journal.push(p);
      return { id: "contexte" };
    },
    completion: async (p: Record<string, unknown>, cb?: (d: { token?: string }) => void) => {
      journal.push(p);
      for (const t of ["o", "k"]) cb?.({ token: t });
      return { text: "ok", timings: { predicted_per_second: 10 } };
    },
    saveSession: async (f: string) => {
      journal.push({ saveSession: f });
      return 1;
    },
    loadSession: async (f: string) => {
      journal.push({ loadSession: f });
      return { tokens_loaded: 1, prompt: "" };
    },
  } as unknown as PluginLlama;
  return async () => plugin;
}

test("aucune méthode de session n'est appelée, même quand le plugin en expose", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginAvecSession(journal) });
  await m.charger("coder15");
  await m.generer({ system: "s", history: [] });
  await m.generer({ system: "s", history: [] });
  await m.charger("coder05");
  await m.generer({ system: "s", history: [] });
  const sessions = journal.filter((j) => j.saveSession || j.loadSession);
  // Avant, ce module sauvait une fois puis rechargeait à CHAQUE pas : un
  // succès vide, un aller-retour pour rien, et un drapeau `cacheSauve` faux.
  assert.equal(sessions.length, 0, "aucun appel de session : le natif ne sait pas les honorer");
});

test("le moteur n'expose plus d'API de cache, et le nettoyage d'affichage est à part", async () => {
  const journal: Record<string, unknown>[] = [];
  const m = creerMoteurNatif({ ...base, chargerPlugin: pluginAvecSession(journal) });
  await m.charger("coder15");
  // Aucun drapeau de cache à interroger : il n'y a pas de cache.
  assert.ok(!("cacheSauve" in m), "plus de cacheSauve : les méthodes de session ne font rien");
  // Le nettoyage d'affichage existe, mais il est SÉPARÉ du texte rendu par le
  // moteur : c'est l'appelant (couche écran) qui décide quand l'appliquer.
  assert.equal(nettoyerPourAffichage("  <|im_end|>Bonjour<|im_start|> "), "Bonjour");
  assert.equal(await m.generer({ system: "s", history: [] }), "ok", "le moteur, lui, ne nettoie pas");
});
