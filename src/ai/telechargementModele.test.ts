/**
 * Vérification de l'écriture par morceaux ET DE LA REPRISE, hors téléphone.
 *
 * POURQUOI CE TEST EXISTE : un fichier de 400 Mo mal recollé (morceau perdu,
 * base64 mal décodé, `appendFile` qui n'ajoute pas à la fin) produirait un GGUF
 * que le moteur refuserait APRÈS un téléchargement de plusieurs minutes, et le
 * diagnostic serait « modèle corrompu » au lieu de « notre code a mal écrit ».
 * On vérifie donc l'octet près : la concaténation des écritures doit être
 * EXACTEMENT le flux reçu, quelles que soient les tailles des morceaux du réseau.
 *
 * DEUXIÈME RAISON, APPRISE SUR TÉLÉPHONE : le 30B fait 8,01 Go et le serveur a
 * répondu HTTP 429 (« trop de requêtes ») après plusieurs minutes. Repartir de
 * zéro à chaque refus, c'est perdre tout ce qui est déjà écrit. Les tests
 * ci-dessous couvrent donc aussi : le nouvel essai après 429 (avec `Retry-After`),
 * la reprise par `Range` après une coupure en plein flux, le cas où le serveur
 * IGNORE `Range` (il faut alors repartir proprement de zéro), et le fait qu'un
 * échec laisse le fichier partiel EN PLACE — c'est lui qui permet la reprise.
 *
 * Les tests passent `octetsAttendus` (option réservée aux tests) pour vérifier la
 * complétude sans écrire 398 Mo : la taille réelle vient de la table des modèles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENTE_BASE_MS,
  delaiEssai,
  messageRefus,
  telechargerModeleParFetch,
  TAILLE_MORCEAU,
  type PluginEcriture,
} from "./telechargementModele.ts";
import { modeleGguf } from "./moteurNatif.ts";

/** Plugin en mémoire : garde les écritures en base64, comme le vrai plugin. */
function pluginMemoire() {
  const appels: string[] = [];
  const morceaux: string[] = [];
  let effacements = 0;

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
      morceaux.length = 0; // un vrai effacement remet le fichier à zéro
      return {};
    },
    // `stat` rend la taille RÉELLE de ce qui est écrit : c'est elle que le module
    // relit pour savoir s'il peut reprendre et si le fichier est complet.
    stat: async () => {
      appels.push("stat");
      return { size: Buffer.concat(morceaux.map((m) => Buffer.from(m, "base64"))).length };
    },
  };

  return {
    plugin,
    appels,
    effacements: () => effacements,
    ecrits: () => Buffer.concat(morceaux.map((m) => Buffer.from(m, "base64"))),
    ecritures: () => appels.filter((a) => a === "writeFile" || a === "appendFile").length,
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

/**
 * Faux SERVEUR qui se comporte comme le CDN du Hub : il honore `Range` (206),
 * peut refuser les premières requêtes (429 + `Retry-After`), peut couper le flux
 * en plein milieu, et peut ignorer `Range` (comme un serveur mal configuré). Il
 * enregistre chaque requête (en-tête `Range`, statut) pour qu'on puisse VÉRIFIER
 * que la reprise a bien été demandée.
 */
function serveur(
  source: Uint8Array,
  options: {
    refus?: { statut: number; retryAfter?: string }[];
    coupeApres?: number;
    tailleMorceau?: number;
    ignoreRange?: boolean;
  } = {},
) {
  const requetes: { range: string | null; statut: number }[] = [];
  const refus = [...(options.refus ?? [])];
  let coupes = 0;
  const tailleMorceau = options.tailleMorceau ?? 1024 * 1024;

  const fetcher = (async (_url: string, init?: RequestInit) => {
    const entetes = new Headers((init?.headers ?? {}) as Record<string, string>);
    const portee = entetes.get("range");
    const debut = portee ? Number(/bytes=(\d+)-/.exec(portee)?.[1] ?? 0) : 0;

    if (refus.length > 0) {
      const r = refus.shift() as { statut: number; retryAfter?: string };
      requetes.push({ range: portee, statut: r.statut });
      const h = new Headers();
      if (r.retryAfter) h.set("retry-after", r.retryAfter);
      return new Response("refus", { status: r.statut, headers: h });
    }

    const vraimentRepris = debut > 0 && !options.ignoreRange;
    const statut = vraimentRepris ? 206 : 200;
    const depuis = vraimentRepris ? debut : 0;
    // Première passe uniquement : coupe le flux après N octets.
    const limite =
      options.coupeApres !== undefined && coupes === 0 ? ((coupes += 1), options.coupeApres) : Number.POSITIVE_INFINITY;
    let emis = 0;
    let position = depuis;
    const stream = new ReadableStream<Uint8Array>({
      pull(controleur) {
        if (emis >= limite) {
          controleur.error(new Error("coupure réseau simulée"));
          return;
        }
        if (position >= source.length) {
          controleur.close();
          return;
        }
        const bloc = source.subarray(position, Math.min(position + tailleMorceau, source.length));
        position += bloc.length;
        emis += bloc.length;
        controleur.enqueue(bloc);
      },
    });
    requetes.push({ range: portee, statut });
    return new Response(stream, { status: statut });
  }) as unknown as typeof fetch;

  return { fetcher, requetes };
}

/** Attente enregistrée, jamais subie : on vérifie le délai demandé au serveur. */
function attentesFactices() {
  const demandes: number[] = [];
  return {
    demandes,
    attendre: async (ms: number) => {
      demandes.push(ms);
    },
  };
}

const MOI = "coder05";

test("le flux est écrit octet pour octet, en morceaux réguliers de 2 Mio", async () => {
  // 5,5 Mio : traverse trois frontières d'écriture (2 Mio, 4 Mio), donc le
  // dernier morceau est PARTIEL — le cas qu'un code naïf perd.
  const taille = Math.round(5.5 * 1024 * 1024);
  const source = Uint8Array.from({ length: taille }, (_, i) => (i * 31 + 7) % 256);
  const memoire = pluginMemoire();

  const progres: number[] = [];
  const resultat = await telechargerModeleParFetch(MOI, (p) => progres.push(p.octetsRecus), {
    fetcher: reponseEnFlux(source, [3 * 1024 * 1024, 100, 5 * 1024 * 1024, 7]),
    plugin: memoire.plugin,
    octetsAttendus: taille,
  });

  assert.equal(resultat.octets, taille);
  assert.equal(resultat.chemin, `Documents/${modeleGguf(MOI).fichier}`);
  assert.equal(resultat.essais, 1, "une seule passe : rien à reprendre");
  // LE CONTRÔLE QUI COMPTE : le contenu écrit est identique à la source.
  assert.deepEqual(memoire.ecrits(), Buffer.from(source), "octets écrits identiques au flux reçu");
  // On interroge le disque D'ABORD (reprise éventuelle), puis une seule création.
  assert.equal(memoire.appels[0], "stat", "on regarde d'abord s'il y a un partiel à reprendre");
  assert.equal(memoire.appels.filter((a) => a === "writeFile").length, 1, "jamais deux créations");
  assert.ok(memoire.appels.includes("appendFile"));
  assert.equal(memoire.appels.at(-1), "stat", "la taille est relue sur le disque");
  assert.equal(memoire.ecritures(), Math.ceil(taille / TAILLE_MORCEAU), "autant d'écritures que de morceaux de 2 Mio");
  assert.equal(progres.at(-1), taille, "le dernier avancement vaut le total reçu");
});

test("un HTTP 403 est refusé du premier coup, sans réessai et sans écrire", async () => {
  const memoire = pluginMemoire();
  const { fetcher, requetes } = serveur(Uint8Array.from([1, 2, 3]), {
    refus: [{ statut: 403 }, { statut: 403 }, { statut: 403 }, { statut: 403 }, { statut: 403 }],
  });
  const attentes = attentesFactices();

  await assert.rejects(
    () => telechargerModeleParFetch(MOI, undefined, { fetcher, plugin: memoire.plugin, attendre: attentes.attendre }),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /HTTP 403/, "le code HTTP est cité");
      assert.match(m, /huggingface\.co/, "l'URL est citée");
      return true;
    },
  );
  assert.equal(requetes.length, 1, "un refus définitif n'est pas réessayé");
  assert.equal(attentes.demandes.length, 0, "aucune attente inutile");
  assert.equal(memoire.ecritures(), 0, "aucune écriture tentée");
});

test("HTTP 429 : nouvel essai après le délai du serveur, et le fichier aboutit", async () => {
  const taille = 3 * 1024 * 1024;
  const source = Uint8Array.from({ length: taille }, (_, i) => (i * 7 + 3) % 251);
  const memoire = pluginMemoire();
  const { fetcher, requetes } = serveur(source, { refus: [{ statut: 429, retryAfter: "7" }] });
  const attentes = attentesFactices();

  const resultat = await telechargerModeleParFetch(MOI, undefined, {
    fetcher,
    plugin: memoire.plugin,
    attendre: attentes.attendre,
    octetsAttendus: taille,
  });

  assert.equal(requetes.length, 2, "deux passes : le refus, puis la réussite");
  assert.deepEqual(attentes.demandes, [7000], "le `Retry-After: 7` du serveur est respecté");
  assert.equal(resultat.essais, 2);
  assert.deepEqual(memoire.ecrits(), Buffer.from(source), "le fichier écrit est complet et exact");
});

test("coupure en plein flux : la 2e requête reprend par `Range`, fichier identique", async () => {
  const taille = 6 * 1024 * 1024 + 12345;
  const source = Uint8Array.from({ length: taille }, (_, i) => (i * 13 + 5) % 256);
  const memoire = pluginMemoire();
  // Première passe : 3 Mio puis coupure. Deux morceaux de 1 Mio sont écrits, le
  // troisième reste en mémoire et est perdu — c'est la taille ÉCRITE qui compte.
  const { fetcher, requetes } = serveur(source, { coupeApres: 3 * 1024 * 1024 });
  const attentes = attentesFactices();

  const resultat = await telechargerModeleParFetch(MOI, undefined, {
    fetcher,
    plugin: memoire.plugin,
    attendre: attentes.attendre,
    octetsAttendus: taille,
  });

  assert.equal(requetes.length, 2);
  assert.equal(requetes[0].range, null, "première requête : le fichier entier");
  assert.equal(
    requetes[1].range,
    `bytes=${2 * 1024 * 1024}-`,
    "la reprise demande EXACTEMENT ce qui est écrit sur le disque",
  );
  assert.equal(requetes[1].statut, 206, "le serveur répond en contenu partiel");
  assert.equal(resultat.essais, 2);
  assert.deepEqual(memoire.ecrits(), Buffer.from(source), "aucun octet dupliqué, aucun octet manquant");
  assert.equal(attentes.demandes.length, 1, "une seule attente, avant la reprise");
});

test("serveur qui IGNORE `Range` : on repart de zéro au lieu de doubler le fichier", async () => {
  const taille = 5 * 1024 * 1024;
  const source = Uint8Array.from({ length: taille }, (_, i) => (i * 17 + 11) % 256);
  const memoire = pluginMemoire();
  const { fetcher, requetes } = serveur(source, { coupeApres: 3 * 1024 * 1024, ignoreRange: true });

  const resultat = await telechargerModeleParFetch(MOI, undefined, {
    fetcher,
    plugin: memoire.plugin,
    attendre: attentesFactices().attendre,
    octetsAttendus: taille,
  });

  assert.equal(requetes.length, 2);
  assert.equal(requetes[1].statut, 200, "le serveur renvoie tout depuis le début");
  assert.ok(memoire.effacements() >= 1, "le partiel est effacé avant de recommencer");
  assert.equal(resultat.octets, taille);
  assert.deepEqual(memoire.ecrits(), Buffer.from(source), "fichier exact, pas doublé");
});

test("échec persistant : message nommant l'écart, partiel CONSERVÉ pour la reprise", async () => {
  const taille = 4 * 1024 * 1024;
  const source = Uint8Array.from({ length: taille }, (_, i) => i % 241);
  const memoire = pluginMemoire();
  // Le serveur envoie 200 000 octets de MOINS que la taille annoncée : au-delà de
  // la tolérance de 2 % (83 Ko ici), le fichier ne peut jamais être déclaré complet
  // — c'est le cas « il manque des octets » qu'il faut savoir dire.
  const { fetcher, requetes } = serveur(source);

  await assert.rejects(
    () =>
      telechargerModeleParFetch(MOI, undefined, {
        fetcher,
        plugin: memoire.plugin,
        attendre: attentesFactices().attendre,
        octetsAttendus: source.length + 200_000,
      }),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /au lieu de/, "l'écart de taille est nommé");
      assert.match(m, /4 essais/, "le nombre d'essais est dit");
      assert.match(m, /conservé/, "on précise que le partiel reste pour la reprise");
      return true;
    },
  );
  assert.equal(requetes.length, 4, "quatre passes, pas plus");
  assert.equal(memoire.effacements(), 0, "le partiel n'est PAS effacé — c'est lui qui permet la reprise");
});

test("`Retry-After` : en secondes, en date HTTP, et à défaut attente croissante bornée", () => {
  const t0 = Date.UTC(2026, 8, 12, 20, 0, 0);
  assert.equal(delaiEssai("12", 1, t0), 12_000, "secondes");
  assert.equal(delaiEssai(new Date(t0 + 30_000).toUTCString(), 1, t0), 30_000, "date HTTP : on attend le moment demandé");
  assert.equal(delaiEssai(null, 1, t0), ATTENTE_BASE_MS, "premier essai : attente de base");
  assert.equal(delaiEssai(null, 2, t0), ATTENTE_BASE_MS * 3, "puis ×3");
  assert.equal(delaiEssai("99999", 1, t0), 120_000, "bornée à 2 minutes");
  assert.equal(delaiEssai("pas une date", 3, t0), ATTENTE_BASE_MS * 9, "valeur illisible : attente croissante");
});

test("le message du 429 dit quoi faire (IP partagée, VPN) et annonce la reprise", () => {
  const m = messageRefus(429, "https://huggingface.co/x/y.gguf");
  assert.match(m, /429/);
  assert.match(m, /VPN/, "la cause la plus fréquente est nommée");
  assert.match(m, /reprendra où il s'est arrêté/, "on annonce la reprise, pas un redémarrage");
  assert.match(messageRefus(500, "https://huggingface.co/x"), /momentanément indisponible/);
});
