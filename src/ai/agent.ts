/**
 * Harnais d'agent LOCAL — la partie qui transforme un petit modèle en ouvrier.
 *
 * Constat de départ, vérifié dans le code : l'appli avait les briques (un
 * studio qui exécute du code, une liste d'outils déclarés) mais AUCUN appel
 * d'outil décidé par le modèle, aucune boucle, aucune mémoire. Les événements
 * d'outils étaient fabriqués par un routeur à mots-clés.
 *
 * DEUXIÈME CONSTAT, mesuré ensuite sur téléphone : le harnais d'origine
 * demandait à CHAQUE pas un seul objet JSON avec un budget unique de 160 jetons,
 * et sous grammaire. Une app HTML de 60 lignes pèse 800 à 1500 jetons : le JSON
 * était coupé par `n_predict` à tous les coups, l'analyseur ne trouvait rien de
 * fermé, la boucle concluait « illisible » et redemandait la même chose avec le
 * même budget. En mode contraint, AUCUNE app ne pouvait sortir, quel que soit le
 * modèle — et l'écran affichait la concaténation des JSON coupés comme réponse.
 *
 * Le harnais est donc réécrit autour de trois séparations :
 *
 *  1. DÉCISION ≠ PRODUCTION. Le pas de décision est minuscule et CONTRAINT par
 *     une grammaire : `<tool_call>{"name":…,"arguments":{…}}</tool_call>`, le
 *     format sur lequel Qwen2.5-Coder-Instruct a été entraîné (smoke-testé sur
 *     les trois modèles), avec des arguments courts. Le CONTENU long (l'HTML
 *     d'une app, le code à exécuter, la réponse finale) est produit dans un
 *     second appel, SANS grammaire, avec un budget large et un arrêt sur
 *     `</html>` : plus d'échappement `\"`/`\n` d'un document entier dans une
 *     chaîne JSON — c'est cette taxe qui tuait le 0,5B. Les budgets sont PAR
 *     OUTIL (`BUDGETS`), pas un chiffre unique.
 *
 *  2. TRONQUÉ ≠ ILLISIBLE. Le moteur dit pourquoi il s'est arrêté
 *     (`BilanGeneration.raison`) : une sortie coupée par `n_predict` est un
 *     verdict « tronqué », traité autrement qu'un JSON cassé — le budget de la
 *     redemande est doublé (jamais le même budget deux fois), et une production
 *     coupée est DITE coupée (« coupé à N jetons »), jamais rafistolée.
 *
 *  3. DÉCLARÉ ≠ FAIT (voir `achevement.ts`). Le modèle énonce d'abord un CONTRAT
 *     de critères vérifiables par exécution ; le harnais les exécute lui-même ;
 *     `done` sans preuve recoupée est refusé ; au plafond, le rapport dit
 *     exactement ce qui est vérifié et ce qui ne l'est pas.
 *
 * Ce qui reste du premier harnais et qu'il faut protéger : l'analyse TOLÉRANTE
 * (l'ancien protocole `{action,nom,args}` et la balise ```tool sont toujours
 * lus), les pas courts et bornés (`maxPas`), la vérification PAR EXÉCUTION dont
 * l'erreur RÉELLE revient au modèle, la mémoire locale bornée, et l'injection de
 * toutes les dépendances (`generate`, `executer`, `verifier`, `journal`) : la
 * boucle se teste sans navigateur ni modèle.
 *
 * CHAQUE APPEL AU MOTEUR ÉCRIT UNE LIGNE DE TRACE (`ligneTracePas`) : pas,
 * phase, réglages, jetons, raison d'arrêt, durées, verdict, outil. C'est la
 * donnée que la frise à l'écran affiche — les deux lisent le même `PasAgent`.
 * La ligne est NOTÉE, pas attendue : le journal ne ralentit jamais un pas.
 */
import {
  type Artefacts,
  type EtatAchevement,
  type EtatCritere,
  type ResultatExecution,
  type Verificateur,
  analyserContrat,
  compteVerifies,
  creerVerificateur,
  etatsInitiaux,
  GRAMMAIRE_CONTRAT,
  rapportFinal,
  recouperDone,
  resumeAchevement,
  verifierTout,
} from "./achevement.ts";
import { noter } from "./journal.ts";
import type { BilanGeneration } from "./types.ts";

export const MAX_PAS_DEFAUT = 6;
const MAX_NOTES = 24;
const MAX_CHARS_MEMOIRE = 1800;
const CLE_MEMOIRE = "studio-local:memoire";

export type Outil = {
  nom: string;
  args: Record<string, unknown>;
};

/** Un outil EXÉCUTÉ (compatibilité : la liste `etapes` ne contient que ceux-là). */
export type Etape = {
  pas: number;
  outil: string;
  args: Record<string, unknown>;
  resultat: string;
};

/**
 * BUDGETS PAR PHASE ET PAR OUTIL, en jetons. Une table explicite, parce que c'est
 * un budget unique (160) qui rendait `write_app` impossible.
 *
 *  - `contrat` : 1 à 4 critères en JSON. 160 suffit à quatre critères courts ;
 *    coupé → redemandé avec le double.
 *  - `decision` : `<tool_call>{"name":"write_app","arguments":{"title":"…"}}</tool_call>`
 *    tient en ~25 jetons ; 48 laisse la place à un titre ou une note un peu longs.
 *    C'est volontairement minuscule : le modèle ne peut ni dériver ni déverser.
 *  - `production` : l'HTML d'une app (1500 — une app de 60 lignes pèse 800 à
 *    1500 jetons ; au 0,5B à 19,6 tok/s, c'est ~75 s, le prix d'une app), le
 *    code d'un `run_js` (400), la réponse finale (200 : quelques phrases).
 *    Une production coupée n'est JAMAIS relancée automatiquement au même
 *    budget : elle est dite coupée, et c'est le modèle qui décide.
 */
export const BUDGETS = {
  contrat: 160,
  decision: 48,
  // Un script Python utile fait 20 à 60 lignes : 800 jetons, pas 400. Le budget
  // est PAR OUTIL, c'est ce qui évite de couper un script en plein milieu.
  production: { write_app: 1500, run_js: 400, run_python: 800, done: 200 } as Record<string, number>,
} as const;
export type Budgets = { contrat: number; decision: number; production: Record<string, number> };

/** Outils exposés au modèle. Peu nombreux, et chacun fait une chose. */
export const OUTILS = [
  {
    nom: "run_js",
    description:
      "Exécute du JavaScript dans un bac à sable et renvoie le résultat. Appelle-le SANS argument : le code te sera demandé juste après.",
    parametres: { type: "object", properties: {}, required: [] },
  },
  {
    nom: "run_python",
    description:
      "Exécute un script PYTHON dans l'appli et renvoie sa sortie RÉELLE (ce qu'il affiche) ou son erreur exacte, avec le numéro de ligne. " +
      "Bibliothèque standard seulement (pas de numpy). Appelle-le SANS argument : le code te sera demandé juste après. " +
      "Les boucles doivent être bornées.",
    parametres: { type: "object", properties: {}, required: [] },
  },
  {
    nom: "write_app",
    description:
      "Écrit une application HTML complète dans le studio (jeu, canvas, widget). Donne seulement le titre : l'HTML te sera demandé juste après. Sans URL externe.",
    parametres: {
      type: "object",
      properties: { title: { type: "string", description: "titre court" } },
      required: ["title"],
    },
  },
  {
    nom: "remember",
    description: "Enregistre un fait durable pour les prochaines tâches (état, décision, résultat).",
    parametres: {
      type: "object",
      properties: { note: { type: "string", description: "une phrase courte" } },
      required: ["note"],
    },
  },
  {
    nom: "done",
    description:
      "Termine la tâche. criteres_ok : les numéros des critères du contrat que tu as VUS réussir dans les résultats d'outils. Sans preuve, done est refusé.",
    parametres: {
      type: "object",
      properties: { criteres_ok: { type: "array", items: { type: "integer" } } },
      required: ["criteres_ok"],
    },
  },
] as const;

const NOMS_OUTILS: readonly string[] = OUTILS.map((o) => o.nom);
const OUTILS_CONNUS = new Set<string>(NOMS_OUTILS);

/**
 * GRAMMAIRE DE DÉCISION (GBNF) — le format d'entraînement de Qwen, fermé :
 *
 *   <tool_call>{"name":"write_app","arguments":{"title":"Pong"}}</tool_call>
 *
 * Le nom est ÉNUMÉRÉ (un outil inventé est impossible), et les arguments sont
 * ceux de l'outil, courts : pas d'`html`, pas de `code` — le contenu vient au
 * pas de production. Un seul mode de fin : `done`. Le sous-ensemble GBNF utilisé
 * (alternatives, répétitions, classes) est celui que llama.cpp gère partout.
 *
 * `String.raw` : les antislashs doivent rester littéraux pour GBNF.
 */
export const GRAMMAIRE_DECISION = String.raw`
root ::= "<tool_call>" espace "{" espace "\"name\"" espace ":" espace appel espace "}" espace "</tool_call>"
appel ::= a-run | a-python | a-app | a-memo | a-done
a-run ::= "\"run_js\"" espace "," espace "\"arguments\"" espace ":" espace "{" espace "}"
a-python ::= "\"run_python\"" espace "," espace "\"arguments\"" espace ":" espace "{" espace "}"
a-app ::= "\"write_app\"" espace "," espace "\"arguments\"" espace ":" espace "{" espace "\"title\"" espace ":" espace chaine espace "}"
a-memo ::= "\"remember\"" espace "," espace "\"arguments\"" espace ":" espace "{" espace "\"note\"" espace ":" espace chaine espace "}"
a-done ::= "\"done\"" espace "," espace "\"arguments\"" espace ":" espace "{" espace "\"criteres_ok\"" espace ":" espace "[" espace (entier (espace "," espace entier)*)? espace "]" espace "}"
entier ::= [1-9] [0-9]?
chaine ::= "\"" caractere* "\""
caractere ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
espace ::= [ \t\n\r]*
`;

/** Conservé pour les lecteurs de l'ancien protocole ; la décision utilise `GRAMMAIRE_DECISION`. */
export const GRAMMAIRE_SORTIE = GRAMMAIRE_DECISION;

/** Contrainte de génération transmise à un moteur qui sait l'appliquer. */
export type Contraintes = {
  /** Grammaire GBNF. */
  grammar?: string;
  /** Schéma JSON (chaîne) — conservé dans le contrat, plus utilisé par défaut. */
  jsonSchema?: string;
};

/**
 * Mode de contrainte. `grammaire` (défaut) : la décision et le contrat sont
 * contraints par GBNF ; la production ne l'est jamais. `aucune` : rien n'est
 * contraint — l'analyse tolérante fait tout le travail (utile pour mesurer).
 */
export type ModeContrainte = "grammaire" | "aucune";

/** Construit la contrainte à transmettre pour une phase. `undefined` = aucune. */
export function contraintesHarnais(
  mode: ModeContrainte = "grammaire",
  phase: "decision" | "contrat" = "decision",
): Contraintes | undefined {
  if (mode === "aucune") return undefined;
  return { grammar: phase === "contrat" ? GRAMMAIRE_CONTRAT : GRAMMAIRE_DECISION };
}

/* ------------------------------------------------------------------ *
 * Analyse TOLÉRANTE de la sortie du modèle
 * ------------------------------------------------------------------ */

/**
 * Extrait tous les objets JSON équilibrés d'un texte, en ignorant les accolades
 * situées DANS les chaînes (sinon `{"code":"a{b}"}` serait coupé au milieu).
 * Un objet non refermé (le petit modèle oublie le `}`, ou la sortie est coupée)
 * n'est pas extrait ici : la boucle le verra comme illisible ou tronqué selon
 * la raison d'arrêt du moteur.
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

/**
 * Candidats à analyser, dans l'ordre de confiance : le contenu des balises
 * `<tool_call>` (format d'entraînement), puis les blocs ```tool / ```json, puis
 * tout objet équilibré du texte.
 */
function objetsJsonCandidats(texte: string): string[] {
  const candidats: string[] = [];
  const reToolCall = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/gi;
  for (const m of texte.matchAll(reToolCall)) {
    if (m[1]) candidats.push(...objetsEquilibres(m[1]));
  }
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

/** Un objet d'arguments exploitable, ou un objet vide (jamais `null`). */
function argsPropres(valeur: unknown): Record<string, unknown> {
  return valeur && typeof valeur === "object" && !Array.isArray(valeur)
    ? (valeur as Record<string, unknown>)
    : {};
}

/** Lit un objet comme appel d'outil, sous l'une des trois formes acceptées. */
function appelDepuisObjet(o: Record<string, unknown>): { outil: Outil } | { inconnu: string } | null {
  // Format d'entraînement : {"name":…,"arguments":{…}} (aussi {"name":…,"args":{…}}, l'ancienne balise ```tool).
  if (typeof o.name === "string") {
    const nom = o.name.trim();
    if (!OUTILS_CONNUS.has(nom)) return { inconnu: nom };
    return { outil: { nom, args: argsPropres(o.arguments ?? o.args) } };
  }
  // Ancien protocole maison : {"action":"outil","nom":…,"args":{…}}.
  if (o.action === "outil") {
    const nom = typeof o.nom === "string" ? o.nom.trim() : "";
    if (!OUTILS_CONNUS.has(nom)) return { inconnu: nom };
    return { outil: { nom, args: argsPropres(o.args) } };
  }
  return null;
}

/**
 * Extrait l'appel d'outil d'une réponse de modèle.
 *
 * Accepte les TROIS formes :
 *  - `<tool_call>{"name":"run_js","arguments":{}}</tool_call>` — le format
 *    d'entraînement, et celui que la grammaire produit ;
 *  - l'ancien protocole maison `{"action":"outil","nom":"run_js","args":{…}}` ;
 *  - l'ancienne balise ```tool `{"name":"run_js","args":{…}}`.
 *
 * Tolérant à la forme (texte autour, clôture oubliée, virgule finale) mais
 * strict sur le fond : sans nom d'outil CONNU, on ne devine rien — on renvoie
 * null et un outil inconnu n'est JAMAIS exécuté.
 */
export function analyserAppel(texte: string): Outil | null {
  for (const brut of objetsJsonCandidats(texte)) {
    const o = lireObjet(brut);
    if (!o) continue;
    const lu = appelDepuisObjet(o);
    if (lu && "outil" in lu) return lu.outil;
  }
  return null;
}

/** Vrai si le texte RESSEMBLE à une tentative d'appel d'outil, même ratée. */
export function ressembleAAppel(texte: string): boolean {
  return (
    /<tool_call>/i.test(texte) ||
    /```(?:tool|json)/i.test(texte) ||
    /"action"\s*:/.test(texte) ||
    /"nom"\s*:/.test(texte) ||
    /"name"\s*:/.test(texte) ||
    /"arguments"\s*:/.test(texte) ||
    /\bname\s*:\s*["']?(run_js|run_python|write_app|remember|done)/i.test(texte)
  );
}

/** Résultat complet de l'analyse d'un pas : outil, réponse en clair, ou illisible. */
export type SortieAnalysee =
  | { type: "outil"; outil: Outil }
  | { type: "reponse"; texte: string }
  | { type: "illisible" };

/**
 * Analyse un pas COMPLET, en gardant la distinction dont la boucle a besoin :
 *  - `outil`   : un appel valide, à exécuter ;
 *  - `reponse` : du texte en clair (le modèle a répondu sans appeler d'outil) ;
 *  - `illisible`: une tentative d'appel ratée (outil inconnu, JSON cassé) qu'il
 *    faut REDEMANDER — surtout pas prendre pour une réponse finale.
 *
 * Un outil inconnu devient `illisible`, jamais `reponse` : on ne laisse pas
 * fuiter un faux appel sous forme de texte, et on ne l'exécute jamais.
 * L'ancien `{"action":"reponse","texte":…}` est lu comme texte en clair.
 */
export function analyserSortie(texte: string): SortieAnalysee {
  for (const brut of objetsJsonCandidats(texte)) {
    const o = lireObjet(brut);
    if (!o) continue;
    if (o.action === "reponse") {
      if (typeof o.texte === "string") return { type: "reponse", texte: o.texte.trim() };
      return { type: "illisible" };
    }
    const lu = appelDepuisObjet(o);
    if (lu === null) continue;
    if ("inconnu" in lu) return { type: "illisible" };
    return { type: "outil", outil: lu.outil };
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

/* ------------------------------------------------------------------ *
 * Exécution de code : calcul pur, dans un Worker
 * ------------------------------------------------------------------ */

/**
 * PREMIER FILTRE : la syntaxe, sans exécuter. `new Function(code)` analyse le
 * code et lève une `SyntaxError` exacte (message du moteur JS) sans en exécuter
 * une ligne, sans DOM requis. Une erreur de syntaxe est renvoyée telle quelle,
 * avant même de lancer un Worker. `null` = syntaxe acceptée.
 *
 * On essaie d'abord le code comme corps de fonction, puis comme expression
 * (« 1+1 » n'est pas un corps de fonction valide seul en mode strict avec
 * `return`, mais un programme valide) : le code n'est refusé que si aucune des
 * deux lectures ne passe.
 */
export function erreurSyntaxe(code: string): string | null {
  if (typeof Function === "undefined") return null;
  try {
    new Function(code);
    return null;
  } catch (e) {
    try {
      new Function(`return (${code}\n)`);
      return null;
    } catch {
      return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }
}

/**
 * Exécute du JavaScript dans un Web Worker isolé, avec délai de garde.
 * Pas d'accès au DOM ni aux variables de la page ; on ne récupère que la
 * valeur de retour ou l'erreur. RÉSERVÉ AU CALCUL PUR : le script d'une app
 * (document, canvas, window) n'a rien à faire ici — il tourne dans l'aperçu,
 * et c'est là qu'il est vérifié (voir session.ts). Exécuter le script d'une app
 * dans ce Worker produisait « document is not defined », une erreur FAUSSE que
 * le modèle recevait comme vraie.
 */
export async function executerJsStructure(code: string, timeoutMs = 2000): Promise<ResultatExecution> {
  const syntaxe = erreurSyntaxe(code);
  if (syntaxe !== null) return { ok: false, erreur: syntaxe };
  if (typeof Worker === "undefined" || typeof Blob === "undefined") {
    return { ok: false, erreur: "exécution impossible ici (pas de Web Worker)" };
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
  return new Promise<ResultatExecution>((resolve) => {
    const finir = (r: ResultatExecution) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const minuteur = setTimeout(() => finir({ ok: false, erreur: `délai dépassé (${timeoutMs} ms)` }), timeoutMs);
    worker.onmessage = (e: MessageEvent) => {
      clearTimeout(minuteur);
      const d = e.data as { ok: boolean; valeur?: string; erreur?: string };
      finir(d.ok ? { ok: true, valeur: d.valeur ?? "" } : { ok: false, erreur: d.erreur ?? "inconnue" });
    };
    worker.onerror = (e: ErrorEvent) => {
      clearTimeout(minuteur);
      finir({ ok: false, erreur: e.message });
    };
    worker.postMessage(code);
  });
}

/** Même exécution, rendue en texte pour le modèle : « → valeur » ou « erreur : … ». */
export async function executerJs(code: string, timeoutMs = 2000): Promise<string> {
  const r = await executerJsStructure(code, timeoutMs);
  return r.ok ? `→ ${r.valeur}` : `erreur : ${r.erreur}`;
}

/* ------------------------------------------------------------------ *
 * La boucle
 * ------------------------------------------------------------------ */

/** Les trois phases d'un pas ; la décision et sa production partagent le numéro de pas. */
export type PhasePas = "contrat" | "decision" | "production";

/**
 * Le verdict d'un appel au moteur — « tronqué » est DISTINCT d'« illisible » :
 *  - `contrat`   : un contrat lisible (au moins un critère accepté) ;
 *  - `outil`     : un appel d'outil valide, exécuté (ou une production complète) ;
 *  - `reponse`   : du texte en clair, hors protocole ;
 *  - `illisible` : le modèle a FINI (eos) mais le format est cassé ou l'outil inconnu ;
 *  - `tronque`   : la sortie a été COUPÉE par `n_predict` (ou le contexte est plein) ;
 *  - `refuse`    : un `done` recoupé et refusé, ou un contrat entièrement refusé.
 */
export type Verdict = "contrat" | "outil" | "reponse" | "illisible" | "tronque" | "refuse";

/** UN appel au moteur, avec tout ce qui a été mesuré. Une ligne de frise = une ligne de trace. */
export type PasAgent = {
  /** Numéro d'ordre de l'appel au moteur dans le tour (1, 2, 3…) : la clé de la frise. */
  id: number;
  pas: number;
  phase: PhasePas;
  /** Outil décidé ou produit ; `null` pour le contrat ou une sortie illisible. */
  outil: string | null;
  verdict: Verdict;
  /** Bilan RÉEL du moteur ; `null` si le moteur n'en a pas fourni (« — » partout). */
  bilan: BilanGeneration | null;
  /** Budget demandé pour cet appel (`n_predict`). */
  budget: number;
  /** Durée totale de l'appel, mesurée ici (ms). */
  dureeMs: number;
  /** Texte BRUT rendu par le moteur (pour dérouler le pas à l'écran). */
  sortie: string;
  /** Ce qui a été renvoyé au modèle : résultat d'outil, refus, ou consigne. */
  resultat: string;
  /** État des critères APRÈS ce pas (copie), pour la frise. */
  criteres: EtatCritere[];
};

/** Ce que la boucle demande au moteur. */
export type DemandeGeneration = {
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  /** `n_predict` pour cet appel — vient de `BUDGETS`, jamais un chiffre unique. */
  budget: number;
  contraintes?: Contraintes;
  /** Chaînes d'arrêt supplémentaires (`</html>` pour la production d'une app). */
  stop?: string[];
  phase: PhasePas;
  outil?: string;
};

/** Ce que le moteur rend : le texte, et le bilan quand il sait le donner. */
export type SortieMoteur = { texte: string; bilan: BilanGeneration | null };

export type ContexteAgent = {
  question: string;
  system: string;
  /**
   * Génère une réponse. Rend le texte brut, ou `{texte, bilan}` quand le moteur
   * sait dire pourquoi il s'est arrêté (voir `BilanGeneration`). Un moteur qui
   * ne rend qu'une chaîne continue de fonctionner : tout ce qui n'est pas
   * mesuré reste « — ». Injecté pour les tests.
   */
  generate: (demande: DemandeGeneration) => Promise<string | SortieMoteur>;
  /** Exécute un outil. Injecté : en vrai, il touche le studio et la mémoire. */
  executer: (outil: Outil) => Promise<string>;
  /**
   * Vérifie un critère par EXÉCUTION. Défaut : `creerVerificateur` sur le
   * Worker (calcul pur) — sans aperçu, donc `app_sans_erreur` et le `run_js`
   * d'une app sont « non vérifiés ». session.ts fournit l'aperçu réel.
   */
  verifier?: Verificateur;
  onEtape?: (etape: Etape) => void;
  /** Chaque appel au moteur, avec son bilan : c'est ce que la frise affiche. */
  onPas?: (pas: PasAgent) => void;
  /** L'état d'achèvement, à chaque changement. */
  onAchevement?: (etat: EtatAchevement) => void;
  maxPas?: number;
  modeContrainte?: ModeContrainte;
  budgets?: Partial<Budgets>;
  /** Où écrire la ligne de trace de chaque pas. Défaut : `noter` (jamais attendu). */
  journal?: (ligne: string) => void;
  /** Horloge (ms), injectable pour les tests. */
  maintenant?: () => number;
};

export type ResultatAgent = {
  reponse: string;
  etapes: Etape[];
  /** Tous les appels au moteur, dans l'ordre. */
  pas: PasAgent[];
  /** Vrai si la boucle s'est arrêtée sur un `done` ACCEPTÉ. */
  termine: boolean;
  /** Vrai si le plafond de pas a été atteint. */
  plafondAtteint: boolean;
  achevement: EtatAchevement;
  /** Le dernier HTML produit par `write_app` dans ce tour, s'il y en a un. */
  html: string | null;
};

/**
 * Le prompt système du harnais : le système de l'appli, puis le bloc d'outils
 * dans la forme EXACTE du gabarit d'entraînement de Qwen2.5 (balises `<tools>`,
 * `<tool_call>`, clés `name`/`arguments`) — c'est ce qui coûte le moins cher au
 * petit modèle —, puis les règles en français, puis la mémoire.
 */
export function promptSystemeHarnais(system: string, memoire: string[]): string {
  const signatures = OUTILS.map((o) =>
    JSON.stringify({
      type: "function",
      function: { name: o.nom, description: o.description, parameters: o.parametres },
    }),
  ).join("\n");
  const memoireBloc =
    memoire.length > 0
      ? `\nMÉMOIRE (faits déjà connus sur cette machine, à réutiliser) :\n${memoire.map((n) => `- ${n}`).join("\n")}\n`
      : "";
  return [
    system,
    "",
    "# Tools",
    "",
    "You may call one or more functions to assist with the user query.",
    "",
    "You are provided with function signatures within <tools></tools> XML tags:",
    "<tools>",
    signatures,
    "</tools>",
    "",
    "For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:",
    "<tool_call>",
    '{"name": <function-name>, "arguments": <args-json-object>}',
    "</tool_call>",
    "",
    "RÈGLES : un seul appel d'outil par message, rien d'autre. " +
      "run_js, run_python et write_app : le code te sera demandé juste après, n'en mets pas dans les arguments. " +
      "Si un outil renvoie une erreur, corrige au lieu d'inventer un résultat. " +
      "Tu es hors ligne : aucune URL externe. " +
      "done n'est accepté que si chaque critère du contrat a été VU réussir.",
    memoireBloc,
  ].join("\n");
}

/** La demande de contrat, envoyée avec la tâche au premier pas. */
export function consigneContrat(): string {
  return [
    "Avant d'agir, énonce le CONTRAT : ce qui doit être VRAI à la fin, vérifiable par exécution.",
    "Réponds UNIQUEMENT par un tableau JSON de 1 à 4 critères, parmi ces quatre formes :",
    '  {"type":"run_js","code":"2+2","attendu":"4"}   (exécuter ce JavaScript doit rendre exactement attendu)',
    '  {"type":"run_python","code":"print(6*7)","attendu":"42"}   (exécuter ce Python doit AFFICHER exactement attendu)',
    '  {"type":"app_sans_erreur"}                      (l\'app s\'affiche sans erreur console)',
    '  {"type":"contient","texte":"requestAnimationFrame"}   (l\'app ou la réponse contient ce texte)',
    "Un critère invérifiable (« ça marche », « le code est propre ») est refusé.",
  ].join("\n");
}

/** La consigne de production, par outil. */
export function consigneProduction(outil: string, args: Record<string, unknown>): string {
  if (outil === "write_app") {
    const titre = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "l'application";
    return (
      `Écris maintenant le document HTML complet de « ${titre} » : UNIQUEMENT le code, ` +
      "de <!DOCTYPE html> à </html>, sans explication ni bloc markdown. " +
      "Fond #09090b, JavaScript et CSS natifs dans le document, aucune URL externe, et tout dans un seul <script>."
    );
  }
  if (outil === "run_js") {
    return (
      "Écris maintenant UNIQUEMENT le code JavaScript à exécuter (une expression ou un court programme " +
      "dont la dernière expression est le résultat), sans explication ni bloc markdown."
    );
  }
  if (outil === "run_python") {
    return (
      "Écris maintenant UNIQUEMENT le script PYTHON à exécuter : le code, sans explication ni bloc markdown. " +
      "Ce que le script AFFICHE (print) est ce que l'utilisateur verra : affiche le résultat. " +
      "Bibliothèque standard seulement, aucune URL, et des boucles BORNÉES (un script qui boucle à l'infini " +
      "ne peut pas être interrompu)."
    );
  }
  return "Rédige maintenant ta réponse finale pour l'utilisateur, en clair et brièvement, dans sa langue.";
}

/** Le texte des critères tel qu'il est renvoyé au modèle après chaque pas. */
export function texteCriteres(etats: EtatCritere[]): string {
  if (etats.length === 0) return "";
  const lignes = etats.map((e) => {
    const marque = e.etat === "ok" ? "✓" : e.etat === "echec" ? "✗" : "○";
    const detail = e.preuve
      ? ` — ${e.preuve.observe}${e.preuve.erreur ? ` — erreur : ${e.preuve.erreur}` : ""}`
      : " — pas encore vérifié";
    return `  ${e.n}. ${marque} ${e.libelle}${detail}`;
  });
  return `CRITÈRES (vérifiés par exécution, pas par toi) :\n${lignes.join("\n")}`;
}

/** Nombre lisible ou « — » : jamais un zéro inventé à la place d'une mesure absente. */
function ouTiret(v: number | null | undefined, suffixe = ""): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v}${suffixe}` : "—";
}

/**
 * LA LIGNE DE TRACE D'UN PAS — pure, et exportée : la frise à l'écran et le
 * fichier journal la lisent depuis le MÊME `PasAgent`. Tous les champs
 * demandés y sont : pas, phase, n_ctx, threads, jetons de prompt, jetons
 * prédits / budget, raison d'arrêt, verdict, outil, pré-remplissage, décodage,
 * critères vérifiés.
 */
export function ligneTracePas(p: PasAgent): string {
  const b = p.bilan;
  const { ok, total } = compteVerifies(p.criteres);
  return [
    `pas ${p.pas}`,
    p.phase,
    `n_ctx ${ouTiret(b?.nCtx)}`,
    `threads ${ouTiret(b?.nThreads)}`,
    `prompt ${ouTiret(b?.jetonsPrompt)} jetons`,
    `prédits ${ouTiret(b?.jetonsPredits)}/${p.budget}`,
    `arrêt ${b ? b.raison + (b.chaineArret ? ` « ${b.chaineArret} »` : "") : "—"}`,
    `verdict ${p.verdict}`,
    `outil ${p.outil ?? "—"}`,
    `préremplissage ${ouTiret(b?.msPreremplissage, " ms")}`,
    `décodage ${ouTiret(b?.msDecodage, " ms")}`,
    `appel ${p.dureeMs} ms`,
    total > 0 ? `critères ${ok}/${total}` : "critères —",
    b?.promptTronque ? "PROMPT TRONQUÉ" : null,
  ]
    .filter((m): m is string => m !== null)
    .join(" · ");
}

/** Le premier document HTML d'un texte, sans exiger `</html>` (la production peut être coupée). */
export function extraireHtmlProduit(texte: string): string | null {
  const fence = texte.match(/```(?:html|HTML)?\s*\n([\s\S]*?)(?:```|$)/);
  const source = fence?.[1] && /<html|<!doctype/i.test(fence[1]) ? fence[1] : texte;
  const debut = source.search(/<!DOCTYPE html|<html/i);
  if (debut < 0) return null;
  const fin = source.search(/<\/html>/i);
  return fin >= 0 ? source.slice(debut, fin + "</html>".length) : source.slice(debut).trimEnd();
}

/** Le code d'un texte de production : le contenu du bloc ``` s'il y en a un, sinon tout. */
export function extraireCodeProduit(texte: string): string {
  const fence = texte.match(/```(?:js|javascript)?\s*\n([\s\S]*?)(?:```|$)/i);
  return (fence?.[1] ?? texte).trim();
}

/**
 * La boucle. Elle s'arrête sur un `done` ACCEPTÉ, au plafond, ou quand le
 * contexte est plein. Rien n'est caché : chaque appel au moteur est remonté via
 * `onPas` et écrit dans la trace ; chaque outil exécuté via `onEtape`.
 */
export async function boucleAgent(ctx: ContexteAgent): Promise<ResultatAgent> {
  const maxPas = ctx.maxPas ?? MAX_PAS_DEFAUT;
  const mode = ctx.modeContrainte ?? "grammaire";
  const budgets: Budgets = {
    contrat: ctx.budgets?.contrat ?? BUDGETS.contrat,
    decision: ctx.budgets?.decision ?? BUDGETS.decision,
    production: { ...BUDGETS.production, ...(ctx.budgets?.production ?? {}) },
  };
  const maintenant = ctx.maintenant ?? (() => Date.now());
  const journal = ctx.journal ?? noter;
  const verifier = ctx.verifier ?? creerVerificateur({ executerJs: executerJsStructure });

  const etapes: Etape[] = [];
  const pasFaits: PasAgent[] = [];
  const history: DemandeGeneration["history"] = [];
  const artefacts: Artefacts = { html: null, reponse: null };
  let criteres: EtatCritere[] = [];
  let contratAccepte = false;
  let tronque = false;
  let pas = 0;
  let budgetContrat = budgets.contrat;
  let budgetDecision = budgets.decision;

  const achevement = (conclu: boolean, motif: string | null): EtatAchevement => ({
    criteres,
    complet: criteres.length > 0 && criteres.every((c) => c.etat === "ok"),
    conclu,
    pasUtilises: pas,
    plafond: maxPas,
    tronque,
    motif,
  });

  /** Un appel au moteur, mesuré, tracé, remonté. */
  const appeler = async (
    demande: Omit<DemandeGeneration, "system" | "history">,
    verdictDe: (texte: string, bilan: BilanGeneration | null) => { verdict: Verdict; outil: string | null },
  ): Promise<{ texte: string; bilan: BilanGeneration | null; pasAgent: PasAgent }> => {
    const debut = maintenant();
    const brut = await ctx.generate({
      system: promptSystemeHarnais(ctx.system, lireMemoire()),
      history: [...history],
      ...demande,
    });
    const texte = typeof brut === "string" ? brut : brut.texte;
    const bilan = typeof brut === "string" ? null : brut.bilan;
    const { verdict, outil } = verdictDe(texte, bilan);
    if (verdict === "tronque") tronque = true;
    const pasAgent: PasAgent = {
      id: pasFaits.length + 1,
      pas,
      phase: demande.phase,
      outil,
      verdict,
      bilan,
      budget: demande.budget,
      dureeMs: Math.max(0, maintenant() - debut),
      sortie: texte,
      resultat: "",
      criteres: criteres.map((c) => ({ ...c })),
    };
    // Inscrit DANS L'ORDRE DES APPELS, dès l'appel : la frise est chronologique
    // même quand un pas se clôt après le suivant (la réponse finale d'un `done`
    // est produite avant que le recoupement ne tranche le sort de la décision).
    pasFaits.push(pasAgent);
    return { texte, bilan, pasAgent };
  };

  /** Clôt un pas : résultat renvoyé au modèle, trace (jamais attendue), frise. */
  const clore = (pasAgent: PasAgent, resultat: string) => {
    pasAgent.resultat = resultat;
    pasAgent.criteres = criteres.map((c) => ({ ...c }));
    try {
      journal(ligneTracePas(pasAgent));
    } catch {
      /* la trace ne doit jamais casser un pas */
    }
    ctx.onPas?.(pasAgent);
  };

  const coupe = (bilan: BilanGeneration | null): boolean =>
    bilan !== null && (bilan.raison === "limite" || bilan.raison === "contexte_plein");

  /** Le contexte est plein ou le prompt a été rogné : continuer n'a plus de sens. */
  const contexteSature = (bilan: BilanGeneration | null): string | null => {
    if (!bilan) return null;
    if (bilan.raison === "contexte_plein") {
      return `contexte plein (n_ctx ${ouTiret(bilan.nCtx)}) : le moteur n'a plus de place pour continuer.`;
    }
    if (bilan.promptTronque) {
      return `le prompt ne tient pas dans le contexte (n_ctx ${ouTiret(bilan.nCtx)}) : le moteur l'a rogné, le modèle n'a pas vu toute la tâche.`;
    }
    return null;
  };

  const finir = (reponse: string, termine: boolean, plafond: boolean, motif: string | null): ResultatAgent => {
    const etat = achevement(termine, motif);
    ctx.onAchevement?.(etat);
    journal(`fin du tour · ${resumeAchevement(etat)}${motif ? ` · ${motif}` : ""}`);
    return { reponse, etapes, pas: pasFaits, termine, plafondAtteint: plafond, achevement: etat, html: artefacts.html };
  };

  const rapportPlafond = (motif: string): string => {
    const lignes = [rapportFinal(achevement(false, motif))];
    if (artefacts.reponse) lignes.push(`Dernière réponse du modèle (non conclue) :\n${artefacts.reponse}`);
    return lignes.join("\n\n");
  };

  history.push({ role: "user", content: `TÂCHE : ${ctx.question}\n\n${consigneContrat()}` });

  while (pas < maxPas) {
    pas += 1;

    /* ─── PHASE 1 : LE CONTRAT ─────────────────────────────────────── */
    if (!contratAccepte) {
      const { texte, bilan, pasAgent } = await appeler(
        { phase: "contrat", budget: budgetContrat, contraintes: contraintesHarnais(mode, "contrat") },
        (t, b) => {
          const lu = analyserContrat(t);
          if (lu.acceptes.length > 0) return { verdict: "contrat", outil: null };
          if (coupe(b)) return { verdict: "tronque", outil: null };
          return { verdict: lu.vide ? "illisible" : "refuse", outil: null };
        },
      );
      history.push({ role: "assistant", content: texte });
      const sature = contexteSature(bilan);
      if (sature) {
        clore(pasAgent, sature);
        return finir(rapportPlafond(sature), false, false, sature);
      }
      const lu = analyserContrat(texte);
      if (lu.acceptes.length > 0) {
        criteres = etatsInitiaux(lu.acceptes);
        contratAccepte = true;
        const refus = lu.refuses.map((r) => `refusé (${r.raison})`).join(" ; ");
        const consigne =
          `CONTRAT retenu :\n${texteCriteres(criteres)}` +
          (refus ? `\nCritères ignorés : ${refus}.` : "") +
          "\nAgis maintenant : un seul appel d'outil.";
        history.push({ role: "user", content: consigne });
        clore(pasAgent, consigne);
        ctx.onAchevement?.(achevement(false, null));
        continue;
      }
      // Aucun critère accepté : on redemande, en disant POURQUOI — coupé (plus de
      // budget), refusé (les raisons, une par critère), ou rien de lisible.
      let consigne: string;
      if (pasAgent.verdict === "tronque") {
        consigne =
          `TA SORTIE A ÉTÉ COUPÉE à ${ouTiret(bilan?.jetonsPredits)} jetons (limite ${budgetContrat}). ` +
          "Réponds plus court : 1 ou 2 critères suffisent.\n" +
          consigneContrat();
        budgetContrat *= 2;
      } else if (pasAgent.verdict === "refuse") {
        consigne =
          `CONTRAT REFUSÉ : ${lu.refuses.map((r) => r.raison).join(" ; ")}. ` +
          "Remplace par des critères vérifiables par exécution.\n" +
          consigneContrat();
      } else {
        consigne = `CONTRAT ILLISIBLE : réponds UNIQUEMENT par le tableau JSON demandé.\n${consigneContrat()}`;
      }
      history.push({ role: "user", content: consigne });
      clore(pasAgent, consigne);
      continue;
    }

    /* ─── PHASE 2 : LA DÉCISION ────────────────────────────────────── */
    const decision = await appeler(
      { phase: "decision", budget: budgetDecision, contraintes: contraintesHarnais(mode, "decision") },
      (t, b) => {
        const a = analyserSortie(t);
        if (a.type === "outil") return { verdict: "outil", outil: a.outil.nom };
        if (coupe(b)) return { verdict: "tronque", outil: null };
        return { verdict: a.type === "reponse" ? "reponse" : "illisible", outil: null };
      },
    );
    history.push({ role: "assistant", content: decision.texte });
    const sature = contexteSature(decision.bilan);
    if (sature) {
      clore(decision.pasAgent, sature);
      return finir(rapportPlafond(sature), false, false, sature);
    }
    const analyse = analyserSortie(decision.texte);
    const suffixePas = `\n(Pas ${pas} sur ${maxPas}.)`;

    if (analyse.type !== "outil") {
      let consigne: string;
      if (decision.pasAgent.verdict === "tronque") {
        // COUPÉ, pas cassé : on le dit, et on ne redemande JAMAIS au même budget.
        consigne =
          `TA SORTIE A ÉTÉ COUPÉE à ${ouTiret(decision.bilan?.jetonsPredits)} jetons (limite ${budgetDecision}). ` +
          "Réponds par un seul appel d'outil, court (titre ou note en quelques mots)." +
          suffixePas;
        budgetDecision *= 2;
      } else if (analyse.type === "reponse") {
        // Texte en clair hors protocole : noté comme BROUILLON de réponse (il
        // pourra servir au rapport final), mais il ne termine rien — la fin,
        // c'est `done`, recoupé.
        artefacts.reponse = analyse.texte || artefacts.reponse;
        consigne =
          "Ta réponse est notée comme brouillon, mais elle ne termine pas la tâche. " +
          'Pour terminer, appelle done : <tool_call>{"name":"done","arguments":{"criteres_ok":[…]}}</tool_call>' +
          suffixePas;
      } else {
        consigne =
          "TON APPEL ÉTAIT ILLISIBLE (format cassé ou outil inconnu). Réponds UNIQUEMENT par " +
          '<tool_call>{"name":"run_js","arguments":{}}</tool_call> (ou write_app, remember, done).' +
          suffixePas;
      }
      history.push({ role: "user", content: consigne });
      clore(decision.pasAgent, consigne);
      continue;
    }

    const appel = analyse.outil;

    /* ─── `done` : RECOUPÉ, jamais cru ─────────────────────────────── */
    if (appel.nom === "done") {
      // Ordre : s'il y a une app, on vérifie d'abord (la réponse finale ne sert
      // à rien si done est refusé) ; sinon la réponse EST l'artefact à examiner
      // (`contient`), donc on la produit d'abord.
      let production: Awaited<ReturnType<typeof appeler>> | null = null;
      const produireReponse = async () => {
        history.push({ role: "user", content: consigneProduction("done", appel.args) });
        production = await appeler(
          { phase: "production", budget: budgets.production.done, outil: "done" },
          (t, b) => ({ verdict: coupe(b) ? "tronque" : t.trim() ? "outil" : "illisible", outil: "done" }),
        );
        history.push({ role: "assistant", content: production.texte });
        if (production.texte.trim()) artefacts.reponse = production.texte.trim();
      };
      if (artefacts.html === null) await produireReponse();
      criteres = await verifierTout(criteres, artefacts, verifier);
      const recoupement = recouperDone(appel.args, criteres);
      if (recoupement.accepte && artefacts.html !== null) await produireReponse();

      if (production !== null) {
        const p = production as Awaited<ReturnType<typeof appeler>>;
        clore(
          p.pasAgent,
          p.pasAgent.verdict === "tronque"
            ? `réponse coupée à ${ouTiret(p.bilan?.jetonsPredits)} jetons (limite ${budgets.production.done})`
            : "réponse finale produite",
        );
      }
      if (recoupement.accepte) {
        clore(decision.pasAgent, recoupement.motif);
        const texteFinal = artefacts.reponse ?? "";
        const pProd = production as Awaited<ReturnType<typeof appeler>> | null;
        const note =
          pProd && pProd.pasAgent.verdict === "tronque"
            ? `\n\n(réponse coupée à ${ouTiret(pProd.bilan?.jetonsPredits)} jetons)`
            : "";
        return finir(texteFinal + note, true, false, null);
      }
      // REFUSÉ : le motif — avec les erreurs réelles — repart au modèle, la tâche reste ouverte.
      decision.pasAgent.verdict = "refuse";
      const consigne = `<tool_response>\n${recoupement.motif}\n</tool_response>\n${texteCriteres(criteres)}${suffixePas}`;
      history.push({ role: "user", content: consigne });
      clore(decision.pasAgent, recoupement.motif);
      ctx.onAchevement?.(achevement(false, null));
      continue;
    }

    /* ─── PRODUCTION du contenu long (write_app, run_js) ───────────── */
    let argsOutil: Record<string, unknown> = { ...appel.args };
    if (appel.nom === "write_app" || appel.nom === "run_js") {
      const inline = appel.nom === "write_app" ? appel.args.html : appel.args.code;
      if (typeof inline === "string" && inline.trim()) {
        // Tolérance : le modèle a mis le contenu dans les arguments (sans
        // grammaire, c'est possible). On le prend tel quel, sans second appel.
        argsOutil = appel.nom === "write_app" ? { ...appel.args, html: inline } : { ...appel.args, code: inline };
      } else {
        history.push({ role: "user", content: consigneProduction(appel.nom, appel.args) });
        const budget = budgets.production[appel.nom] ?? 400;
        const production = await appeler(
          {
            phase: "production",
            budget,
            outil: appel.nom,
            stop: appel.nom === "write_app" ? ["</html>"] : undefined,
          },
          (t, b) => {
            if (appel.nom === "write_app") {
              if (/<\/html>/i.test(t)) return { verdict: "outil", outil: appel.nom };
              if (coupe(b)) return { verdict: "tronque", outil: appel.nom };
              return { verdict: extraireHtmlProduit(t) ? "outil" : "illisible", outil: appel.nom };
            }
            if (coupe(b)) return { verdict: "tronque", outil: appel.nom };
            return { verdict: extraireCodeProduit(t) ? "outil" : "illisible", outil: appel.nom };
          },
        );
        history.push({ role: "assistant", content: production.texte });
        const satureProd = contexteSature(production.bilan);
        if (satureProd) {
          clore(decision.pasAgent, `décision : ${appel.nom}`);
          clore(production.pasAgent, satureProd);
          return finir(rapportPlafond(satureProd), false, false, satureProd);
        }
        const coupee = production.pasAgent.verdict === "tronque";
        const jetons = ouTiret(production.bilan?.jetonsPredits);
        if (appel.nom === "write_app") {
          let html = extraireHtmlProduit(production.texte);
          if (html === null) {
            const consigne =
              `<tool_response>\nAucun document HTML dans ta production (${production.texte.trim().length} caractères).\n</tool_response>` +
              `\nRecommence : appelle write_app, puis écris UNIQUEMENT le HTML, de <!DOCTYPE html> à </html>.${suffixePas}`;
            history.push({ role: "user", content: consigne });
            clore(decision.pasAgent, `décision : ${appel.nom}`);
            clore(production.pasAgent, consigne);
            continue;
          }
          // Le natif s'arrête JUSTE AVANT la chaîne d'arrêt qu'on lui a donnée et
          // la retire du texte : quand il nomme `</html>` comme raison, on remet
          // la balise que le modèle avait bel et bien écrite. On ne le fait QUE
          // sur cette preuve — jamais pour « réparer » un document inachevé.
          if (production.bilan?.chaineArret === "</html>" && !/<\/html>/i.test(html)) html += "</html>";
          argsOutil = {
            ...appel.args,
            html,
            tronque: coupee,
            jetons: production.bilan?.jetonsPredits ?? null,
            budget,
            pas,
          };
        } else {
          argsOutil = { ...appel.args, code: extraireCodeProduit(production.texte), tronque: coupee, budget };
        }
        clore(decision.pasAgent, `décision : ${appel.nom}`);
        // La production est close APRÈS l'exécution (son résultat en dépend) :
        // on garde le pas sous la main.
        const prodPas = production.pasAgent;
        const resultatExecution = await executerOutil({ nom: appel.nom, args: argsOutil }, coupee, jetons, budget);
        clore(prodPas, resultatExecution);
        continue;
      }
    }

    // `remember`, ou un contenu fourni en ligne : exécution directe.
    const resultat = await executerOutil({ nom: appel.nom, args: argsOutil }, false, "—", 0);
    clore(decision.pasAgent, resultat);
  }

  const motif = `plafond de ${maxPas} pas atteint sans done accepté.`;
  return finir(rapportPlafond(motif), false, true, motif);

  /**
   * Exécute un outil, met à jour les artefacts, vérifie les critères, et
   * renvoie au modèle le résultat RÉEL — précédé, si la production a été coupée,
   * de la mention « coupé à N jetons » (jamais rafistolé).
   */
  async function executerOutil(outil: Outil, coupee: boolean, jetons: string, budget: number): Promise<string> {
    let resultat: string;
    try {
      resultat = await ctx.executer(outil);
    } catch (e) {
      resultat = `erreur d'exécution : ${e instanceof Error ? e.message : String(e)}`;
    }
    if (outil.nom === "write_app" && typeof outil.args.html === "string") artefacts.html = outil.args.html;
    if (coupee) {
      resultat = `PRODUCTION COUPÉE à ${jetons} jetons (limite ${budget}) : le contenu est incomplet. ${resultat}`;
    }
    const etape: Etape = { pas, outil: outil.nom, args: outil.args, resultat };
    etapes.push(etape);
    ctx.onEtape?.(etape);

    if (criteres.length > 0 && outil.nom !== "remember") {
      criteres = await verifierTout(criteres, artefacts, verifier);
      ctx.onAchevement?.(achevement(false, null));
    }
    const consigne =
      `<tool_response>\n${resultat.slice(0, 1200)}\n</tool_response>` +
      (criteres.length > 0 ? `\n${texteCriteres(criteres)}` : "") +
      `\n(Pas ${pas} sur ${maxPas}. Une seule action, puis tu t'arrêtes.)`;
    history.push({ role: "user", content: consigne });
    return resultat;
  }
}
