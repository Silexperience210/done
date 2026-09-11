/**
 * Harnais d'agent LOCAL — la partie qui transforme un petit modèle en ouvrier.
 *
 * Constat de départ, vérifié dans le code : l'appli avait les briques (un
 * studio qui exécute du code, une liste d'outils déclarés) mais AUCUN appel
 * d'outil décidé par le modèle, aucune boucle, aucune mémoire. Les événements
 * d'outils étaient fabriqués par un routeur à mots-clés.
 *
 * Ce module ajoute le vrai harnais, et il est conçu POUR UN PETIT MODÈLE :
 *  - une seule balise de sortie, JSON, décrite par un SCHÉMA : à chaque pas le
 *    moteur ne peut produire qu'une action outil OU une réponse ;
 *  - quand le moteur accepte `json_schema` (ou une grammaire GBNF), la
 *    génération est CONTRAINTE : il devient impossible de produire un JSON
 *    invalide, ce qui était la cause d'échec principale des modèles 0,5 à 3 Md
 *    qui déversaient du texte ou du HTML à la place d'un appel ;
 *  - l'analyse reste TOLÉRANTE : nouvel objet `{action,nom,args}`, ancienne
 *    balise ```tool `{name,args}`, et repli en texte si rien n'est analysable ;
 *  - des pas courts et numérotés, jamais plus de `maxPas` ;
 *  - la VÉRIFICATION PAR EXÉCUTION : le code écrit est exécuté, l'erreur est
 *    renvoyée au modèle, qui corrige. C'est ce qui remplace la puissance de
 *    raisonnement qui manque ;
 *  - une MÉMOIRE locale bornée, réinjectée à chaque pas, pour enchaîner les
 *    petites tâches entre elles sans tout garder dans un contexte étroit.
 *
 * La boucle est écrite avec ses dépendances en paramètres (`generate`,
 * `executer`) : elle se teste donc sans navigateur ni modèle.
 */

export const MAX_PAS_DEFAUT = 6;
const MAX_NOTES = 24;
const MAX_CHARS_MEMOIRE = 1800;
const CLE_MEMOIRE = "studio-local:memoire";

export type Outil = {
  nom: string;
  args: Record<string, unknown>;
};

export type Etape = {
  pas: number;
  outil: string;
  args: Record<string, unknown>;
  resultat: string;
};

/** Outils exposés au modèle. Peu nombreux, et chacun fait une chose. */
export const OUTILS = [
  {
    nom: "run_js",
    description: "Exécute du JavaScript dans un bac à sable et renvoie le résultat. À utiliser pour calculer ET pour vérifier du code.",
    args: { code: "du JavaScript, une expression ou un court programme" },
  },
  {
    nom: "write_app",
    description: "Écrit une application HTML complète dans le studio (jeu, canvas, widget). Sans URL externe.",
    args: { title: "titre court", html: "HTML complet, fond #09090b, JS/CSS natif" },
  },
  {
    nom: "remember",
    description: "Enregistre un fait durable pour les prochaines tâches (état, décision, résultat).",
    args: { note: "une phrase courte" },
  },
  {
    nom: "done",
    description: "Termine la tâche et rend la réponse finale à l'utilisateur.",
    args: { summary: "réponse finale, en clair" },
  },
] as const;

const NOMS_OUTILS: readonly string[] = OUTILS.map((o) => o.nom);
const OUTILS_CONNUS = new Set<string>(NOMS_OUTILS);

/**
 * PROTOCOLE DE SORTIE — un seul objet JSON par pas, rien d'autre.
 *
 *   {"action":"outil","nom":"run_js","args":{"code":"1+1"}}
 *   {"action":"reponse","texte":"voici la réponse"}
 *
 * C'est un FORMAT FERMÉ : le schéma ci-dessous ne laisse produire qu'un objet
 * `{action, nom, args, texte}` dont `action` est une des deux valeurs. Le
 * moteur qui honore `json_schema` (ou la grammaire GBNF équivalente,
 * `GRAMMAIRE_SORTIE`) ne PEUT donc plus déverser du texte ou du HTML à la place.
 *
 * Le schéma est volontairement minimal (`type`, `properties`, `enum`,
 * `required`) : c'est le sous-ensemble que le convertisseur schéma→grammaire de
 * llama.cpp gère de façon fiable. On ne s'appuie PAS sur `oneOf`/`const`, dont
 * le support dépend de la version native.
 */
export const SCHEMA_SORTIE = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["outil", "reponse"] },
    nom: { type: "string" },
    args: { type: "object" },
    texte: { type: "string" },
  },
  required: ["action"],
} as const;

/**
 * Même protocole, écrit en GBNF (grammaire de llama.cpp). Équivalent au schéma
 * ci-dessus, mais EXPLICITE : utile si une version du plugin ignore
 * `json_schema`. Fourni comme variante ; le défaut reste `json_schema`, chemin
 * documenté et testé du plugin.
 *
 * `String.raw` : les antislashs doivent rester littéraux pour GBNF (`\"` = un
 * guillemet, `\\` = un antislash), et non être interprétés par JavaScript.
 */
export const GRAMMAIRE_SORTIE = String.raw`
root ::= objet
objet ::= "{" espace "\"action\"" espace ":" espace action
action ::= action-outil | action-reponse
action-outil ::= "\"outil\"" espace "," espace "\"nom\"" espace ":" espace nom espace "," espace "\"args\"" espace ":" espace objet-args
action-reponse ::= "\"reponse\"" espace "," espace "\"texte\"" espace ":" espace chaine
nom ::= "\"run_js\"" | "\"write_app\"" | "\"remember\"" | "\"done\""
objet-args ::= "{" espace (paire (espace "," espace paire)*)? espace "}"
paire ::= chaine espace ":" espace valeur
valeur ::= chaine | nombre | "true" | "false" | "null" | objet-args | tableau
tableau ::= "[" espace (valeur (espace "," espace valeur)*)? espace "]"
chaine ::= "\"" caractere* "\""
caractere ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
nombre ::= "-"? [0-9]+ ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
espace ::= [ \t\n\r]*
`;

/** Contrainte de génération transmise à un moteur qui sait l'appliquer. */
export type Contraintes = {
  /** Schéma JSON (chaîne) : le moteur le convertit en grammaire. */
  jsonSchema?: string;
  /** Grammaire GBNF (prime sur le schéma si le moteur gère les deux). */
  grammar?: string;
};

/** Mode de contrainte demandé par l'appelant. Défaut : schéma JSON. */
export type ModeContrainte = "schema" | "grammaire" | "aucune";

/**
 * Construit la contrainte à transmettre au moteur pour ce mode.
 * `aucune` renvoie `undefined` : le moteur garde son comportement d'origine
 * (utile pour un moteur navigateur qui ignore ces paramètres).
 */
export function contraintesHarnais(mode: ModeContrainte = "schema"): Contraintes | undefined {
  if (mode === "aucune") return undefined;
  if (mode === "grammaire") return { grammar: GRAMMAIRE_SORTIE };
  return { jsonSchema: JSON.stringify(SCHEMA_SORTIE) };
}

/* ------------------------------------------------------------------ *
 * Analyse TOLÉRANTE de la sortie du modèle
 * ------------------------------------------------------------------ */

/**
 * Extrait tous les objets JSON équilibrés d'un texte, en ignorant les accolades
 * situées DANS les chaînes (sinon `{"code":"a{b}"}` serait coupé au milieu).
 * Un objet non refermé (le petit modèle oublie le `}`) n'est pas extrait ici :
 * on le laisse tomber, la boucle le verra comme illisible et redemandera.
 */
function objetsEquilibres(texte: string): string[] {
  const trouves: string[] = [];
  let debut = -1;
  let profondeur = 0;
  let dansChaine = false;
  let echappe = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (dansChaine) {
      if (echappe) echappe = false;
      else if (c === "\\") echappe = true;
      else if (c === '"') dansChaine = false;
      continue;
    }
    if (c === '"') dansChaine = true;
    else if (c === "{") {
      if (profondeur === 0) debut = i;
      profondeur++;
    } else if (c === "}") {
      if (profondeur > 0) {
        profondeur--;
        if (profondeur === 0 && debut >= 0) {
          trouves.push(texte.slice(debut, i + 1));
          debut = -1;
        }
      }
    }
  }
  return trouves;
}

/** Candidats à analyser : d'abord les blocs balisés, puis tout objet équilibré. */
function objetsJsonCandidats(texte: string): string[] {
  const candidats: string[] = [];
  const reBloc = /```(?:tool|json)\s*([\s\S]*?)```/gi;
  for (const m of texte.matchAll(reBloc)) {
    if (m[1]) candidats.push(...objetsEquilibres(m[1].trim()));
  }
  candidats.push(...objetsEquilibres(texte));
  return candidats;
}

/** Retire les virgules finales avant `}` ou `]` — tolérance au petit modèle. */
function nettoyerVirgulesFinales(brut: string): string {
  return brut.replace(/,\s*([}\]])/g, "$1");
}

/** Tente de lire un candidat comme objet JSON. `null` si ce n'en est pas un. */
function lireObjet(brut: string): Record<string, unknown> | null {
  for (const essai of [brut, nettoyerVirgulesFinales(brut)]) {
    try {
      const o = JSON.parse(essai) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      /* on essaie la variante suivante */
    }
  }
  return null;
}

/** Un objet `args` exploitable, ou un objet vide (jamais `null`). */
function argsPropres(valeur: unknown): Record<string, unknown> {
  return valeur && typeof valeur === "object" && !Array.isArray(valeur)
    ? (valeur as Record<string, unknown>)
    : {};
}

/**
 * Extrait l'appel d'outil d'une réponse de modèle.
 *
 * Accepte les DEUX formes :
 *  - le nouveau protocole `{"action":"outil","nom":"run_js","args":{...}}` ;
 *  - l'ancienne balise ```tool `{"name":"run_js","args":{...}}`, conservée pour
 *    ne pas casser une installation ou un modèle plus ancien.
 *
 * Tolérant à la forme (texte autour, clôture oubliée, virgule finale) mais
 * strict sur le fond : sans nom d'outil CONNU, on ne devine rien — on renvoie
 * null et un outil inconnu n'est JAMAIS exécuté.
 */
export function analyserAppel(texte: string): Outil | null {
  for (const brut of objetsJsonCandidats(texte)) {
    const o = lireObjet(brut);
    if (!o) continue;
    // Nouvelle forme : action explicite.
    if (o.action === "outil") {
      const nom = typeof o.nom === "string" ? o.nom.trim() : "";
      if (!OUTILS_CONNUS.has(nom)) continue;
      return { nom, args: argsPropres(o.args) };
    }
    // Ancienne forme : clé `name`.
    const nom = typeof o.name === "string" ? o.name.trim() : "";
    if (!OUTILS_CONNUS.has(nom)) continue;
    return { nom, args: argsPropres(o.args) };
  }
  return null;
}

/** Vrai si le texte RESSEMBLE à une tentative d'appel d'outil, même ratée. */
export function ressembleAAppel(texte: string): boolean {
  return (
    /```(?:tool|json)/i.test(texte) ||
    /"action"\s*:/.test(texte) ||
    /"nom"\s*:/.test(texte) ||
    /"name"\s*:/.test(texte) ||
    /\bname\s*:\s*["']?(run_js|write_app|remember|done)/i.test(texte)
  );
}

/** Résultat complet de l'analyse d'un pas : outil, réponse, ou illisible. */
export type SortieAnalysee =
  | { type: "outil"; outil: Outil }
  | { type: "reponse"; texte: string }
  | { type: "illisible" };

/**
 * Analyse un pas COMPLET, en gardant la distinction dont la boucle a besoin :
 *  - `outil`   : un appel valide, à exécuter ;
 *  - `reponse` : la réponse finale en clair (protocole `action:"reponse"` OU
 *    simple texte) ;
 *  - `illisible`: une tentative d'appel ratée (outil inconnu, JSON cassé) qu'il
 *    faut REDEMANDER — surtout pas prendre pour une réponse finale.
 *
 * Un outil inconnu devient `illisible`, jamais `reponse` : on ne laisse pas
 * fuiter un faux appel sous forme de texte, et on ne l'exécute jamais.
 */
export function analyserSortie(texte: string): SortieAnalysee {
  for (const brut of objetsJsonCandidats(texte)) {
    const o = lireObjet(brut);
    if (!o) continue;
    if (o.action === "reponse") {
      if (typeof o.texte === "string") return { type: "reponse", texte: o.texte.trim() };
      return { type: "illisible" };
    }
    if (o.action === "outil") {
      const nom = typeof o.nom === "string" ? o.nom.trim() : "";
      if (!OUTILS_CONNUS.has(nom)) return { type: "illisible" };
      return { type: "outil", outil: { nom, args: argsPropres(o.args) } };
    }
    // Ancienne forme `{name,args}` sans `action`.
    const nom = typeof o.name === "string" ? o.name.trim() : "";
    if (OUTILS_CONNUS.has(nom)) return { type: "outil", outil: { nom, args: argsPropres(o.args) } };
  }
  if (ressembleAAppel(texte)) return { type: "illisible" };
  return { type: "reponse", texte: texte.trim() };
}

/** Mémoire locale bornée : quelques faits, pas un journal. */
export function lireMemoire(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const brut = JSON.parse(localStorage.getItem(CLE_MEMOIRE) ?? "[]") as unknown;
    if (!Array.isArray(brut)) return [];
    return brut.filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

export function ecrireMemoire(notes: string[]): string[] {
  // On garde les plus récentes, et on borne le volume total : la mémoire est
  // réinjectée dans CHAQUE pas, donc son coût doit rester prévisible.
  let gardees = notes.slice(-MAX_NOTES);
  while (gardees.join("\n").length > MAX_CHARS_MEMOIRE && gardees.length > 1) {
    gardees = gardees.slice(1);
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(CLE_MEMOIRE, JSON.stringify(gardees));
    } catch {
      /* stockage plein ou refusé : la mémoire reste en RAM pour la session */
    }
  }
  return gardees;
}

export function ajouterMemoire(note: string): string[] {
  const propre = note.trim().replace(/\s+/g, " ").slice(0, 240);
  if (!propre) return lireMemoire();
  return ecrireMemoire([...lireMemoire(), propre]);
}

export function oublierMemoire(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(CLE_MEMOIRE);
}

/**
 * Exécute du JavaScript dans un Web Worker isolé, avec délai de garde.
 * Pas d'accès au DOM ni aux variables de la page ; on ne récupère que la
 * valeur de retour ou l'erreur — c'est ce qui rend la vérification utile.
 */
export async function executerJs(code: string, timeoutMs = 2000): Promise<string> {
  if (typeof Worker === "undefined" || typeof Blob === "undefined") {
    return "exécution impossible ici (pas de Web Worker)";
  }
  const source = `
    self.onmessage = (e) => {
      try {
        const valeur = (0, eval)(e.data);
        self.postMessage({ ok: true, valeur: valeur === undefined ? "undefined" : String(valeur) });
      } catch (err) {
        self.postMessage({ ok: false, erreur: String((err && err.message) || err) });
      }
    };`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url);
  return new Promise<string>((resolve) => {
    const finir = (texte: string) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(texte);
    };
    const minuteur = setTimeout(() => finir("délai dépassé (2 s)"), timeoutMs);
    worker.onmessage = (e: MessageEvent) => {
      clearTimeout(minuteur);
      const d = e.data as { ok: boolean; valeur?: string; erreur?: string };
      finir(d.ok ? `→ ${d.valeur ?? ""}` : `erreur : ${d.erreur ?? "inconnue"}`);
    };
    worker.onerror = (e: ErrorEvent) => {
      clearTimeout(minuteur);
      finir(`erreur : ${e.message}`);
    };
    worker.postMessage(code);
  });
}

export type ContexteAgent = {
  question: string;
  system: string;
  /**
   * Génère une réponse à partir du prompt fourni. `contraintes` porte le schéma
   * JSON (ou la grammaire) à appliquer si le moteur sait le faire ; un moteur
   * qui l'ignore continue de fonctionner comme avant. Injecté pour les tests.
   */
  generate: (
    prompt: string,
    onToken?: (t: string) => void,
    contraintes?: Contraintes,
  ) => Promise<string>;
  /** Exécute un outil. Injecté : en vrai, il touche le studio et la mémoire. */
  executer: (outil: Outil) => Promise<string>;
  onEtape?: (etape: Etape) => void;
  onToken?: (t: string) => void;
  maxPas?: number;
  /** Contrainte de sortie à demander au moteur. Défaut : schéma JSON. */
  modeContrainte?: ModeContrainte;
};

export type ResultatAgent = {
  reponse: string;
  etapes: Etape[];
  /** Vrai si la boucle s'est arrêtée sur `done` ou une réponse en clair. */
  termine: boolean;
  /** Vrai si le plafond de pas a été atteint. */
  plafondAtteint: boolean;
};

export function promptSystemeHarnais(system: string, memoire: string[]): string {
  const outils = OUTILS.map((o) => `- ${o.nom} : ${o.description} (args : ${Object.keys(o.args).join(", ")})`).join("\n");
  const memoireBloc =
    memoire.length > 0
      ? `\nMÉMOIRE (faits déjà connus sur cette machine, à réutiliser) :\n${memoire.map((n) => `- ${n}`).join("\n")}\n`
      : "";
  return [
    system,
    "",
    "PETITS PAS : une seule chose à la fois.",
    "À CHAQUE pas, réponds par UN SEUL objet JSON, sans texte autour :",
    '  pour agir     : {"action":"outil","nom":"run_js","args":{"code":"1+1"}}',
    '  pour répondre : {"action":"reponse","texte":"ta réponse finale"}',
    "Un nom d'outil inconnu est refusé. N'écris rien d'autre que cet objet.",
    "",
    "Outils disponibles :",
    outils,
    "",
    "Règles : quand tu écris une application, VÉRIFIE-la ensuite en exécutant son JavaScript avec run_js ; " +
      "si un outil renvoie une erreur, corrige au lieu d'inventer un résultat ; " +
      "termine par {\"action\":\"reponse\",...} ou l'outil done ; tu es hors ligne, donc aucune URL externe.",
    memoireBloc,
  ].join("\n");
}

/**
 * La boucle. Elle s'arrête sur une réponse (`action:"reponse"` ou texte), sur
 * `done`, ou au plafond. Rien n'est caché : chaque pas est remonté via `onEtape`.
 */
export async function boucleAgent(ctx: ContexteAgent): Promise<ResultatAgent> {
  const maxPas = ctx.maxPas ?? MAX_PAS_DEFAUT;
  const contraintes = contraintesHarnais(ctx.modeContrainte ?? "schema");
  const etapes: Etape[] = [];
  let journal = "";
  let dernierTexte = "";

  for (let pas = 1; pas <= maxPas; pas++) {
    const prompt = [
      promptSystemeHarnais(ctx.system, lireMemoire()),
      "",
      `TÂCHE : ${ctx.question}`,
      journal ? `\nDÉJÀ FAIT :\n${journal}` : "",
      pas > 1 ? `\n(Pas ${pas} sur ${maxPas}. Une seule action, puis tu t'arrêtes.)` : "",
    ].join("\n");

    const sortie = await ctx.generate(prompt, ctx.onToken, contraintes);
    const analyse = analyserSortie(sortie);

    if (analyse.type === "illisible") {
      // Le modèle a TENTÉ un appel mais le format est illisible (outil inconnu,
      // JSON cassé). On ne devine rien et on n'exécute rien : on redemande, en
      // corrigeant, tant qu'il reste des pas. Sans ce garde-fou, une seule
      // balise ratée terminait la tâche par un message incompréhensible.
      if (pas < maxPas) {
        journal +=
          `- pas ${pas} · TON APPEL ÉTAIT ILLISIBLE. Réponds UNIQUEMENT par un objet JSON valide : ` +
          `{"action":"outil","nom":"run_js","args":{"code":"1+1"}} ou {"action":"reponse","texte":"..."}.\n`;
        dernierTexte = "format d'appel illisible";
        continue;
      }
      // Dernier pas : faute de mieux, on rend ce que le modèle a produit plutôt
      // qu'un message vide.
      return { reponse: sortie.trim(), etapes, termine: true, plafondAtteint: false };
    }

    if (analyse.type === "reponse") {
      // Réponse finale : la boucle s'arrête là.
      return { reponse: analyse.texte, etapes, termine: true, plafondAtteint: false };
    }

    const appel = analyse.outil;
    if (appel.nom === "done") {
      const resume = typeof appel.args.summary === "string" ? appel.args.summary : sortie;
      return { reponse: resume.trim(), etapes, termine: true, plafondAtteint: false };
    }

    let resultat: string;
    try {
      resultat = await ctx.executer(appel);
    } catch (e) {
      resultat = `erreur d'exécution : ${e instanceof Error ? e.message : String(e)}`;
    }
    const etape: Etape = { pas, outil: appel.nom, args: appel.args, resultat };
    etapes.push(etape);
    ctx.onEtape?.(etape);
    journal += `- pas ${pas} · ${appel.nom} → ${resultat.slice(0, 300)}\n`;
    dernierTexte = resultat;
  }

  return {
    reponse:
      dernierTexte.trim() ||
      "J'ai atteint le nombre maximum d'étapes sans conclure. Reformule la demande ou donne-moi un objectif plus précis.",
    etapes,
    termine: false,
    plafondAtteint: true,
  };
}
