/**
 * Harnais d'agent LOCAL — la partie qui transforme un petit modèle en ouvrier.
 *
 * Constat de départ, vérifié dans le code : l'appli avait les briques (un
 * studio qui exécute du code, une liste d'outils déclarés) mais AUCUN appel
 * d'outil décidé par le modèle, aucune boucle, aucune mémoire. Les événements
 * d'outils étaient fabriqués par un routeur à mots-clés.
 *
 * Ce module ajoute le vrai harnais, et il est conçu POUR UN PETIT MODÈLE :
 *  - une seule balise d'appel, ultra-stricte, pour que le format tienne malgré
 *    un modèle de 0,5 à 3 milliards de paramètres ;
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

/**
 * Extrait l'appel d'outil d'une réponse de modèle.
 *
 * Format imposé (une seule balise, décodage glouton côté génération) :
 *
 * ```tool
 * {"name": "run_js", "args": {"code": "2+2"}}
 * ```
 *
 * Tolérant à la forme (le petit modèle ajoute souvent du texte autour) mais
 * strict sur le fond : sans nom d'outil connu et sans objet `args`, on ne
 * devine rien — on renvoie null et la réponse est traitée comme du texte.
 */
export function analyserAppel(texte: string): Outil | null {
  const bloc = texte.match(/```(?:tool|json)\s*([\s\S]*?)```/i);
  const candidats: string[] = [];
  if (bloc?.[1]) candidats.push(bloc[1].trim());
  // repli : un objet JSON nu sur une ligne, si le modèle a oublié la clôture
  const nu = texte.match(/\{[^{}]*"name"[\s\S]*?\}\s*\}?/);
  if (nu?.[0]) candidats.push(nu[0]);

  const connus = new Set<string>(OUTILS.map((o) => o.nom));
  for (const brut of candidats) {
    for (const essai of [brut, brut.replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const o = JSON.parse(essai) as { name?: unknown; args?: unknown };
        const nom = typeof o.name === "string" ? o.name.trim() : "";
        if (!connus.has(nom)) continue;
        const args =
          o.args && typeof o.args === "object" && !Array.isArray(o.args)
            ? (o.args as Record<string, unknown>)
            : {};
        return { nom, args };
      } catch {
        /* on essaie la variante suivante */
      }
    }
  }
  return null;
}

/** Vrai si le texte RESSEMBLE à une tentative d'appel d'outil, même ratée. */
export function ressembleAAppel(texte: string): boolean {
  return (
    /```(?:tool|json)/i.test(texte) ||
    /"name"\s*:/.test(texte) ||
    /\bname\s*:\s*["']?(run_js|write_app|remember|done)/i.test(texte)
  );
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
  /** Génère une réponse à partir du prompt fourni. Injecté pour les tests. */
  generate: (prompt: string, onToken?: (t: string) => void) => Promise<string>;
  /** Exécute un outil. Injecté : en vrai, il touche le studio et la mémoire. */
  executer: (outil: Outil) => Promise<string>;
  onEtape?: (etape: Etape) => void;
  onToken?: (t: string) => void;
  maxPas?: number;
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
    "Pour agir, réponds EXACTEMENT par un bloc balisé tool contenant un objet JSON, et rien d'autre :",
    '```tool\n{"name": "run_js", "args": {"code": "1+1"}}\n```',
    "Sinon, réponds en texte : c'est ta réponse finale.",
    "",
    "Outils disponibles :",
    outils,
    "",
    "Règles : quand tu écris une application, VÉRIFIE-la ensuite en exécutant son JavaScript avec run_js ; " +
      "si un outil renvoie une erreur, corrige au lieu d'inventer un résultat ; " +
      "termine par done ; tu es hors ligne, donc aucune URL externe.",
    memoireBloc,
  ].join("\n");
}

/**
 * La boucle. Elle s'arrête sur `done`, sur une réponse en texte, ou au plafond.
 * Rien n'est caché : chaque pas est remonté à l'appelant via `onEtape`.
 */
export async function boucleAgent(ctx: ContexteAgent): Promise<ResultatAgent> {
  const maxPas = ctx.maxPas ?? MAX_PAS_DEFAUT;
  const etapes: Etape[] = [];
  let journal = "";
  let dernierTexte = "";
  let plafondAtteint = false;

  for (let pas = 1; pas <= maxPas; pas++) {
    const prompt = [
      promptSystemeHarnais(ctx.system, lireMemoire()),
      "",
      `TÂCHE : ${ctx.question}`,
      journal ? `\nDÉJÀ FAIT :\n${journal}` : "",
      pas > 1 ? `\n(Pas ${pas} sur ${maxPas}. Une seule action, puis tu t'arrêtes.)` : "",
    ].join("\n");

    const sortie = await ctx.generate(prompt, ctx.onToken);
    const appel = analyserAppel(sortie);

    if (!appel) {
      // Le modèle a TENTÉ un appel mais le format est illisible. On ne devine
      // rien et on n'exécute rien : on redemande, en corrigeant, tant qu'il
      // reste des pas. Sans ce garde-fou, une seule balise ratée terminait la
      // tâche par un message incompréhensible pour l'utilisateur.
      if (ressembleAAppel(sortie) && pas < maxPas) {
        journal += `- pas ${pas} · TON APPEL ÉTAIT ILLISIBLE. Réponds uniquement par un bloc \`\`\`tool suivi d'un objet JSON valide, rien d'autre.\n`;
        dernierTexte = "format d'appel illisible";
        continue;
      }
      // Réponse en clair : c'est la réponse finale, la boucle s'arrête là.
      return { reponse: sortie.trim(), etapes, termine: true, plafondAtteint: false };
    }

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

  plafondAtteint = true;
  return {
    reponse:
      dernierTexte.trim() ||
      "J'ai atteint le nombre maximum d'étapes sans conclure. Reformule la demande ou donne-moi un objectif plus précis.",
    etapes,
    termine: false,
    plafondAtteint,
  };
}
