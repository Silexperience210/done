/**
 * Vérification de l'écriture par morceaux, HORS téléphone.
 *
 * POURQUOI CE TEST EXISTE : un fichier de 400 Mo mal recollé (morceau perdu,
 * base64 mal décodé, `appendFile` qui n'ajoute pas à la fin) produirait un GGUF
 * que le moteur refuserait APRÈS un téléchargement de plusieurs minutes, et le
 * diagnostic serait « modèle corrompu » au lieu de « notre code a mal écrit ».
 * On vérifie donc l'octet près : la concaténation des écritures doit être
 * EXACTEMENT le flux reçu, quelles que soient les tailles des morceaux du réseau.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { telechargerModeleParFetch, TAILLE_MORCEAU, type PluginEcriture } from "./telechargementModele.ts";
import { modeleGguf } from "./moteurNatif.ts";

/** Plugin en mémoire : garde les écritures en base64, comme le vrai plugin. */
function pluginMemoire() {
  const appels: string[] = [];
  const morceaux: string[] = [];
  let effacements = 0;
  let tailleAnnoncee: number | null = null;

  const plugin: PluginEcriture = {
    writeFile: async ({ data }) => {
      appels.push("writeFile");
      morceaux.push(data);
      return {};
    },
    appendFile: async ({ data }) => {
      appels.push("appendFile");
      morceaux.push(data);
      return {};
    },
    deleteFile: async () => {
      appels.push("deleteFile");
      effacements += 1;
      return {};
    },
    stat: async () => {
      appels.push("stat");
      return { size: tailleAnnoncee ?? Buffer.concat(morceaux.map((m) => Buffer.from(m, "base64"))).length };
    },
  };

  return {
    plugin,
    appels,
    effacements: () => effacements,
    ecrits: () => Buffer.concat(morceaux.map((m) => Buffer.from(m, "base64"))),
    annoncerTaille: (n: number) => {
      tailleAnnoncee = n;
    },
  };
}

/** Faux `fetch` : renvoie `donnees` découpées en morceaux de tailles irrégulières. */
function reponseEnFlux(donnees: Uint8Array, decoupes: number[]): typeof fetch {
  return (async () => {
    let position = 0;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controleur) {
        if (position >= donnees.length) {
          controleur.close();
          return;
        }
        const taille = decoupes[i % decoupes.length];
        i += 1;
        const bloc = donnees.subarray(position, Math.min(position + taille, donnees.length));
        position += bloc.length;
        controleur.enqueue(bloc);
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/octet-stream" } });
  }) as unknown as typeof fetch;
}

test("le flux est écrit octet pour octet, en morceaux réguliers de 2 Mio", async () => {
  const modele = modeleGguf("coder05");
  // 5,5 Mio : traverse trois frontières d'écriture (2 Mio, 4 Mio), donc le
  // dernier morceau est PARTIEL — le cas qu'un code naïf perd.
  const taille = Math.round(5.5 * 1024 * 1024);
  const source = Uint8Array.from({ length: taille }, (_, i) => (i * 31 + 7) % 256);
  const memoire = pluginMemoire();
  // Le contrôle final de taille porte sur la taille du MODÈLE (398 Mo) : le
  // plugin de test annonce cette taille, comme le vrai après un téléchargement
  // complet. C'est l'égalité des octets qui est vérifiée ici.
  memoire.annoncerTaille(modele.octets);

  const progres: number[] = [];
  const resultat = await telechargerModeleParFetch("coder05", (p) => progres.push(p.octetsRecus), {
    fetcher: reponseEnFlux(source, [3 * 1024 * 1024, 100, 5 * 1024 * 1024, 7]),
    plugin: memoire.plugin,
  });

  assert.equal(resultat.octets, modele.octets);
  assert.equal(resultat.chemin, `Documents/${modele.fichier}`);
  // LE CONTRÔLE QUI COMPTE : le contenu écrit est identique à la source.
  assert.deepEqual(memoire.ecrits(), Buffer.from(source), "octets écrits identiques au flux reçu");
  // Une seule création, puis des ajouts — jamais deux writeFile (qui écraseraient).
  assert.equal(memoire.appels.filter((a) => a === "writeFile").length, 1);
  assert.equal(memoire.appels[0], "deleteFile", "on part d'un état propre");
  assert.ok(memoire.appels.includes("appendFile"));
  assert.equal(memoire.appels.at(-1), "stat", "la taille est relue sur le disque");
  const tailles = memoire.appels.filter((a) => a === "writeFile" || a === "appendFile").length;
  assert.equal(tailles, Math.ceil(taille / TAILLE_MORCEAU), "autant d'écritures que de morceaux de 2 Mio");
  assert.equal(progres.at(-1), taille, "le dernier avancement vaut le total reçu");
});

test("un HTTP en erreur est refusé, sans rien écrire", async () => {
  const memoire = pluginMemoire();
  await assert.rejects(
    () =>
      telechargerModeleParFetch("coder05", undefined, {
        fetcher: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
        plugin: memoire.plugin,
      }),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /HTTP 403/, "le code HTTP est cité");
      assert.match(m, /huggingface\.co/, "l'URL est citée");
      return true;
    },
  );
  assert.equal(memoire.appels.length, 0, "aucune écriture tentée");
});

test("une taille finale fausse fait échouer ET effacer le fichier", async () => {
  const taille = 3 * 1024 * 1024;
  const source = Uint8Array.from({ length: taille }, (_, i) => i % 251);
  const memoire = pluginMemoire();
  // Le disque annonce 100 Mo pour un modèle qui en fait 398 : incomplet.
  memoire.annoncerTaille(100 * 1024 * 1024);

  await assert.rejects(
    () =>
      telechargerModeleParFetch("coder05", undefined, {
        fetcher: reponseEnFlux(source, [1024 * 1024]),
        plugin: memoire.plugin,
      }),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /téléchargement incomplet|au lieu de/, "on dit que c'est incomplet");
      return true;
    },
  );
  // Deux effacements : l'état propre du début, puis le raté.
  assert.equal(memoire.effacements(), 2, "le fichier incomplet est effacé");
});
