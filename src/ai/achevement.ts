/**
 * GARANTIE D'ACHÈVEMENT — ce qui fait qu'une tâche est FAITE, et pas déclarée faite.
 *
 * Le constat de départ : la boucle d'agent s'arrêtait dès que le modèle disait
 * `done`. Rien ne vérifiait que ce qu'il annonçait était vrai ; un petit modèle
 * qui écrit « c'est fait » après une app cassée était cru sur parole, et l'écran
 * affichait une réussite. C'est le mensonge que ce module rend impossible.
 *
 * LA RÈGLE, en une phrase : ce qui est déclaré fait doit avoir été VU fait par le
 * harnais, par exécution, critère par critère — et jamais par le modèle.
 *
 * Les cinq pièces :
 *  1. le CONTRAT : au premier pas, le modèle énonce 1 à 4 critères, chacun d'un
 *     type que le harnais sait EXÉCUTER (`run_js` avec valeur attendue, app sans
 *     erreur console, texte présent dans l'artefact). Un critère d'un autre type
 *     — « ça marche », « le code est propre » — n'est pas vérifiable : il est
 *     REFUSÉ, avec la raison, et le modèle doit le remplacer ;
 *  2. la VÉRIFICATION : le harnais exécute chaque critère là où le code tourne
 *     vraiment (Worker pour un calcul pur, aperçu réel pour une app) et garde la
 *     PREUVE : valeur observée, erreur exacte, durée ;
 *  3. le RECOUPEMENT de `done` : l'outil d'achèvement doit dire quels critères le
 *     modèle a vus réussir (`criteres_ok`). Sans cette liste, `done` est refusé.
 *     Avec, chaque numéro déclaré est confronté à ce que le harnais a lui-même
 *     observé : un critère déclaré réussi mais vu en échec est un MENSONGE, et
 *     `done` est refusé avec l'erreur réelle ;
 *  4. la FIN HONNÊTE : au plafond de pas, le rapport dit exactement où on en est
 *     (« 2 critères sur 3 vérifiés », le critère échoué, l'erreur), jamais
 *     « c'est fait » ;
 *  5. l'ÉTAT MESURÉ : critères ✓/✗, pas utilisés, sortie tronquée ou non — ce
 *     que la frise affiche et ce que la trace écrit. Là où il n'y a pas de
 *     mesure, il n'y a pas de chiffre.
 *
 * Tout est PUR ici (aucune dépendance au navigateur ni au moteur) : l'exécution
 * réelle est injectée (`Verificateur`), donc chaque propriété se teste à sec.
 */

/** Un critère VÉRIFIABLE PAR EXÉCUTION — les seuls types que le harnais accepte. */
export type Critere =
  | {
      /** Exécuter `code` doit rendre exactement `attendu` (comparaison sur le texte, tolérante aux nombres). */
      type: "run_js";
      code: string;
      attendu: string;
    }
  | {
      /** L'app écrite se charge dans l'aperçu réel sans aucune erreur console. */
      type: "app_sans_erreur";
    }
  | {
      /** L'artefact produit (HTML de l'app, sinon la réponse finale) contient ce texte. */
      type: "contient";
      texte: string;
    };

/** Un critère proposé par le modèle et REFUSÉ, avec la raison (renvoyée au modèle). */
export type CritereRefuse = { brut: unknown; raison: string };

/** La PREUVE d'une vérification : ce qui a été observé, pas ce qui a été dit. */
export type Preuve = {
  ok: boolean;
  /** Valeur observée : résultat d'exécution, « chargé sans erreur », extrait trouvé… */
  observe: string;
  /** Erreur EXACTE, texte intégral, quand il y en a une ; `null` sinon. */
  erreur: string | null;
  /** Durée de la vérification, MESURÉE (ms). */
  ms: number;
  /**
   * Vrai quand le harnais N'A PAS PU regarder (aperçu absent, rien à examiner).
   * Ce n'est ni ✓ ni ✗ : c'est une absence de mesure, affichée comme telle.
   */
  nonVerifie?: boolean;
};

/**
 * `non_verifie` est un état à part entière : le harnais N'A PAS PU exécuter le
 * critère (aperçu absent, rien à examiner encore). Il ne vaut ni ✓ ni ✗, et il
 * bloque `done` exactement comme un échec.
 */
export type EtatVerification = "ok" | "echec" | "non_verifie";

export type EtatCritere = {
  /** Numéro du critère (1…4), celui que le modèle cite dans `criteres_ok`. */
  n: number;
  critere: Critere;
  /** Libellé lisible, le même à l'écran et dans la trace. */
  libelle: string;
  etat: EtatVerification;
  preuve: Preuve | null;
};

/** L'état d'achèvement d'un tour — mesuré, affiché tel quel, journalisé tel quel. */
export type EtatAchevement = {
  criteres: EtatCritere[];
  /** Vrai quand TOUS les critères ont été vus réussir par le harnais. */
  complet: boolean;
  /** Vrai quand `done` a été ACCEPTÉ (donc `complet` était vrai à ce moment). */
  conclu: boolean;
  pasUtilises: number;
  plafond: number;
  /** Au moins une sortie du modèle a été coupée par `n_predict` pendant le tour. */
  tronque: boolean;
  /** Pourquoi ce n'est pas conclu (plafond, contexte plein…) ; `null` si conclu. */
  motif: string | null;
};

/** Ce sur quoi un critère peut porter : l'app écrite, ou la réponse produite. */
export type Artefacts = {
  html: string | null;
  reponse: string | null;
};

/** Résultat brut d'une exécution de code, où qu'elle ait eu lieu. */
export type ResultatExecution = { ok: true; valeur: string } | { ok: false; erreur: string };

/**
 * L'exécution RÉELLE, injectée. En production (session.ts) : Worker pour un
 * calcul pur, aperçu (iframe) pour une app. Dans les tests : un double.
 */
export type Verificateur = (critere: Critere, artefacts: Artefacts) => Promise<Preuve>;

export const MAX_CRITERES = 4;

/**
 * GRAMMAIRE DU CONTRAT (GBNF) : un tableau de 1 à 4 critères, chacun d'un des
 * trois types. Sous cette grammaire, un critère invérifiable est IMPOSSIBLE à
 * produire — c'est la première ligne de défense. `analyserContrat` reste
 * tolérant et strict à la fois pour le cas sans grammaire.
 */
export const GRAMMAIRE_CONTRAT = String.raw`
root ::= "[" espace critere (espace "," espace critere)? (espace "," espace critere)? (espace "," espace critere)? espace "]"
critere ::= "{" espace "\"type\"" espace ":" espace (c-run | c-app | c-contient) espace "}"
c-run ::= "\"run_js\"" espace "," espace "\"code\"" espace ":" espace chaine espace "," espace "\"attendu\"" espace ":" espace chaine
c-app ::= "\"app_sans_erreur\""
c-contient ::= "\"contient\"" espace "," espace "\"texte\"" espace ":" espace chaine
chaine ::= "\"" caractere* "\""
caractere ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
espace ::= [ \t\n\r]*
`;

/** Libellé d'un critère — UN seul endroit, pour que l'écran et la trace disent la même chose. */
export function libelleCritere(c: Critere): string {
  switch (c.type) {
    case "run_js":
      return `run_js « ${resume(c.code, 60)} » → attendu « ${resume(c.attendu, 30)} »`;
    case "app_sans_erreur":
      return "l'app s'affiche sans erreur console";
    case "contient":
      return `l'artefact contient « ${resume(c.texte, 40)} »`;
  }
}

function resume(texte: string, max: number): string {
  const plat = texte.replace(/\s+/g, " ").trim();
  return plat.length > max ? `${plat.slice(0, max - 1)}…` : plat;
}

/**
 * Lit un critère proposé et le REFUSE s'il n'est pas vérifiable par exécution.
 * Les raisons sont écrites pour le modèle : il doit pouvoir remplacer.
 */
export function validerCritere(brut: unknown): { critere: Critere } | { refus: CritereRefuse } {
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) {
    return { refus: { brut, raison: "un critère est un objet {type, …}" } };
  }
  const o = brut as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type.trim() : "";
  if (type === "run_js") {
    const code = typeof o.code === "string" ? o.code.trim() : "";
    const attendu =
      typeof o.attendu === "string"
        ? o.attendu.trim()
        : typeof o.attendu === "number" || typeof o.attendu === "boolean"
          ? String(o.attendu)
          : "";
    if (!code) return { refus: { brut, raison: "run_js sans code : rien à exécuter" } };
    if (!attendu) {
      return {
        refus: {
          brut,
          raison: "run_js sans valeur attendue : « ça marche » n'est pas vérifiable, donne la valeur exacte",
        },
      };
    }
    return { critere: { type: "run_js", code, attendu } };
  }
  if (type === "app_sans_erreur") return { critere: { type: "app_sans_erreur" } };
  if (type === "contient") {
    const texte = typeof o.texte === "string" ? o.texte : "";
    if (!texte.trim()) return { refus: { brut, raison: "contient sans texte : rien à chercher" } };
    return { critere: { type: "contient", texte } };
  }
  return {
    refus: {
      brut,
      raison:
        `type « ${type || "?"} » non vérifiable par exécution : ` +
        "utilise run_js (code + attendu), app_sans_erreur, ou contient (texte)",
    },
  };
}

/** Extrait le premier tableau JSON équilibré d'un texte (les crochets dans les chaînes sont ignorés). */
function tableauEquilibre(texte: string): string | null {
  const debut = texte.indexOf("[");
  if (debut < 0) return null;
  let profondeur = 0;
  let dansChaine = false;
  let echappe = false;
  for (let i = debut; i < texte.length; i++) {
    const c = texte[i];
    if (dansChaine) {
      if (echappe) echappe = false;
      else if (c === "\\") echappe = true;
      else if (c === '"') dansChaine = false;
      continue;
    }
    if (c === '"') dansChaine = true;
    else if (c === "[" || c === "{") profondeur++;
    else if (c === "]" || c === "}") {
      profondeur--;
      if (profondeur === 0) return texte.slice(debut, i + 1);
    }
  }
  return null;
}

/** Tous les objets `{…}` équilibrés d'un texte, pour lire un contrat sans crochets. */
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
    } else if (c === "}" && profondeur > 0) {
      profondeur--;
      if (profondeur === 0 && debut >= 0) {
        trouves.push(texte.slice(debut, i + 1));
        debut = -1;
      }
    }
  }
  return trouves;
}

function lireJson(brut: string): unknown {
  for (const essai of [brut, brut.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      return JSON.parse(essai);
    } catch {
      /* variante suivante */
    }
  }
  return undefined;
}

/**
 * ANALYSE DU CONTRAT — tolérante à la forme (tableau, objets nus, virgule
 * finale, texte autour), stricte sur le fond (chaque critère passe par
 * `validerCritere`). Au-delà de `MAX_CRITERES`, les suivants sont refusés : un
 * contrat de dix lignes n'est pas un contrat, c'est un plan.
 *
 * `vide` distingue « rien d'analysable » (sortie coupée, texte libre) d'un
 * contrat lu mais entièrement refusé : la boucle réagit différemment.
 */
export function analyserContrat(texte: string): {
  acceptes: Critere[];
  refuses: CritereRefuse[];
  vide: boolean;
} {
  const candidats: unknown[] = [];
  const tableau = tableauEquilibre(texte);
  const lu = tableau ? lireJson(tableau) : undefined;
  if (Array.isArray(lu)) candidats.push(...lu);
  else if (lu && typeof lu === "object") candidats.push(lu);
  else {
    for (const brut of objetsEquilibres(texte)) {
      const o = lireJson(brut);
      if (o && typeof o === "object") candidats.push(o);
    }
  }
  if (candidats.length === 0) return { acceptes: [], refuses: [], vide: true };

  const acceptes: Critere[] = [];
  const refuses: CritereRefuse[] = [];
  for (const brut of candidats) {
    if (acceptes.length >= MAX_CRITERES) {
      refuses.push({ brut, raison: `au plus ${MAX_CRITERES} critères` });
      continue;
    }
    const v = validerCritere(brut);
    if ("critere" in v) acceptes.push(v.critere);
    else refuses.push(v.refus);
  }
  return { acceptes, refuses, vide: false };
}

/** Les états initiaux (« non vérifié ») d'un contrat accepté. */
export function etatsInitiaux(criteres: Critere[]): EtatCritere[] {
  return criteres.map((c, i) => ({
    n: i + 1,
    critere: c,
    libelle: libelleCritere(c),
    etat: "non_verifie",
    preuve: null,
  }));
}

/**
 * Observé = attendu ? Comparaison sur le TEXTE, après rognage des espaces et des
 * guillemets d'enrobage ; deux nombres sont comparés comme nombres (« 4 » et
 * « 4.0 » sont la même valeur). Rien d'autre n'est toléré : une réussite
 * approximative serait une réussite fabriquée.
 */
export function comparerAttendu(observe: string, attendu: string): boolean {
  const o = deguiller(observe.trim());
  const a = deguiller(attendu.trim());
  if (o === a) return true;
  const no = Number(o);
  const na = Number(a);
  return o !== "" && a !== "" && Number.isFinite(no) && Number.isFinite(na) && no === na;
}

function deguiller(t: string): string {
  return /^(["']).*\1$/.test(t) && t.length >= 2 ? t.slice(1, -1) : t;
}

/** Vérifie `contient` sur l'artefact courant : l'app si elle existe, sinon la réponse. */
export function verifierContient(
  critere: Extract<Critere, { type: "contient" }>,
  artefacts: Artefacts,
  ms = 0,
): Preuve {
  const cible = artefacts.html ?? artefacts.reponse;
  if (cible === null) {
    return {
      ok: false,
      observe: "aucun artefact à examiner pour l'instant",
      erreur: null,
      ms,
      nonVerifie: true,
    };
  }
  const ou = artefacts.html !== null ? "l'app" : "la réponse";
  const trouve = cible.includes(critere.texte);
  return trouve
    ? { ok: true, observe: `« ${resume(critere.texte, 40)} » présent dans ${ou}`, erreur: null, ms }
    : {
        ok: false,
        observe: `« ${resume(critere.texte, 40)} » ABSENT de ${ou} (${cible.length} caractères examinés)`,
        erreur: null,
        ms,
      };
}

/** Transforme un résultat d'exécution en preuve pour un critère `run_js`. */
export function preuveRunJs(
  critere: Extract<Critere, { type: "run_js" }>,
  resultat: ResultatExecution,
  ms: number,
): Preuve {
  if (!resultat.ok) return { ok: false, observe: "exécution en erreur", erreur: resultat.erreur, ms };
  const ok = comparerAttendu(resultat.valeur, critere.attendu);
  return {
    ok,
    observe: ok
      ? `→ ${resume(resultat.valeur, 60)}`
      : `attendu « ${resume(critere.attendu, 30)} », observé « ${resume(resultat.valeur, 60)} »`,
    erreur: null,
    ms,
  };
}

/**
 * VÉRIFICATEUR PAR DÉFAUT — ce que le harnais peut exécuter lui-même.
 *
 *  - `run_js` : exécuté par `executerJs` (le Worker) quand il n'y a pas d'app ;
 *    quand une app existe, par `executerDansApercu` (le code du modèle définit
 *    ses fonctions DANS l'aperçu, pas dans un Worker sans DOM). Sans aperçu
 *    disponible : NON VÉRIFIÉ, et on le dit — on n'exécute pas le critère dans
 *    un environnement où son code ne tourne pas ;
 *  - `app_sans_erreur` : le verdict de l'aperçu réel (`verdictApercu`) ; sans
 *    aperçu : non vérifié ;
 *  - `contient` : lecture directe de l'artefact.
 *
 * Toute exception est une preuve d'échec avec son texte, jamais une exception
 * qui remonte : la vérification ne doit pas casser la boucle.
 */
export function creerVerificateur(executeurs: {
  executerJs: (code: string) => Promise<ResultatExecution>;
  executerDansApercu?: (code: string) => Promise<ResultatExecution | null>;
  verdictApercu?: () => Promise<{ charge: boolean; erreurs: string[] } | null>;
  maintenant?: () => number;
}): Verificateur {
  const maintenant = executeurs.maintenant ?? (() => Date.now());
  return async (critere, artefacts) => {
    const debut = maintenant();
    const duree = () => Math.max(0, maintenant() - debut);
    try {
      if (critere.type === "contient") return verifierContient(critere, artefacts, duree());
      if (critere.type === "run_js") {
        if (artefacts.html !== null) {
          const dansApercu = executeurs.executerDansApercu
            ? await executeurs.executerDansApercu(critere.code)
            : null;
          if (dansApercu === null) {
            return {
              ok: false,
              observe: "non vérifié : l'aperçu de l'app n'est pas disponible pour y exécuter le code",
              erreur: null,
              ms: duree(),
              nonVerifie: true,
            };
          }
          return preuveRunJs(critere, dansApercu, duree());
        }
        return preuveRunJs(critere, await executeurs.executerJs(critere.code), duree());
      }
      // app_sans_erreur
      if (artefacts.html === null) {
        return {
          ok: false,
          observe: "aucune app écrite pour l'instant",
          erreur: null,
          ms: duree(),
          nonVerifie: true,
        };
      }
      const verdict = executeurs.verdictApercu ? await executeurs.verdictApercu() : null;
      if (verdict === null) {
        return {
          ok: false,
          observe: "non vérifié : aucun aperçu réel n'a rendu l'app",
          erreur: null,
          ms: duree(),
          nonVerifie: true,
        };
      }
      if (!verdict.charge) {
        return {
          ok: false,
          observe: "l'aperçu n'a pas signalé la fin du chargement",
          erreur: verdict.erreurs[0] ?? null,
          ms: duree(),
        };
      }
      if (verdict.erreurs.length > 0) {
        return {
          ok: false,
          observe: `${verdict.erreurs.length} erreur(s) console dans l'aperçu`,
          erreur: verdict.erreurs.join(" | "),
          ms: duree(),
        };
      }
      return { ok: true, observe: "chargée sans erreur console", erreur: null, ms: duree() };
    } catch (e) {
      return {
        ok: false,
        observe: "la vérification elle-même a échoué",
        erreur: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        ms: duree(),
      };
    }
  };
}

/**
 * « Non vérifié » est classé à part pour que l'écran ne l'affiche pas comme un
 * ✗ : ce n'est pas le modèle qui a échoué, c'est nous qui n'avons pas pu regarder.
 */
function classer(preuve: Preuve): EtatVerification {
  if (preuve.nonVerifie) return "non_verifie";
  return preuve.ok ? "ok" : "echec";
}

/** Vérifie TOUS les critères, dans l'ordre, et rend les états à jour (les anciens sont remplacés). */
export async function verifierTout(
  etats: EtatCritere[],
  artefacts: Artefacts,
  verifier: Verificateur,
): Promise<EtatCritere[]> {
  const resultat: EtatCritere[] = [];
  for (const e of etats) {
    const preuve = await verifier(e.critere, artefacts);
    resultat.push({ ...e, etat: classer(preuve), preuve });
  }
  return resultat;
}

/** Les numéros de critères déclarés réussis par le modèle dans `done`, ou `null` si absents. */
export function criteresDeclares(args: Record<string, unknown>): number[] | null {
  const brut = args.criteres_ok ?? args.criteres ?? args.verifies;
  if (!Array.isArray(brut)) return null;
  const nums = brut
    .map((v) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN))
    .filter((n) => Number.isInteger(n) && n >= 1);
  return nums.length > 0 ? [...new Set(nums)] : null;
}

export type Recoupement = {
  accepte: boolean;
  /** Texte renvoyé au modèle (refus) ou consigné (acceptation). */
  motif: string;
  /** Numéros déclarés réussis par le modèle alors que le harnais les a vus ÉCHOUER. */
  mensonges: number[];
};

/**
 * LE RECOUPEMENT DE `done` — la règle 3, appliquée sans exception.
 *
 *  - aucun contrat → refusé (rien ne peut être « fait » sans critère) ;
 *  - `criteres_ok` absent ou vide → refusé : « done sans preuve » ;
 *  - un numéro déclaré réussi que le harnais a vu ÉCHOUER → refusé, et c'est un
 *    mensonge : l'erreur réelle est renvoyée ;
 *  - un critère non vérifié par le harnais (aperçu absent…) → refusé : la tâche
 *    reste ouverte, on ne conclut pas sur une absence de mesure ;
 *  - tout critère en échec → refusé, même s'il n'a pas été déclaré ;
 *  - sinon : accepté. Le modèle peut sous-déclarer (il n'a pas cité un critère
 *    que le harnais a pourtant vu réussir) : ce que le harnais a observé prime,
 *    dans les deux sens.
 */
export function recouperDone(args: Record<string, unknown>, etats: EtatCritere[]): Recoupement {
  if (etats.length === 0) {
    return {
      accepte: false,
      mensonges: [],
      motif:
        "done REFUSÉ : aucun critère vérifiable n'a été énoncé. Énonce d'abord le contrat " +
        "(1 à 4 critères run_js / app_sans_erreur / contient).",
    };
  }
  const declares = criteresDeclares(args);
  if (declares === null) {
    return {
      accepte: false,
      mensonges: [],
      motif:
        "done REFUSÉ, sans preuve : indique criteres_ok, la liste des numéros de critères que " +
        "tu as VUS réussir dans les résultats d'outils (ex. {\"criteres_ok\":[1,2]}).",
    };
  }
  const parNumero = new Map(etats.map((e) => [e.n, e]));
  const inconnus = declares.filter((n) => !parNumero.has(n));
  const mensonges = declares.filter((n) => parNumero.get(n)?.etat === "echec");
  const nonVerifies = etats.filter((e) => e.etat === "non_verifie");
  const echecs = etats.filter((e) => e.etat === "echec");

  const lignes: string[] = [];
  if (inconnus.length > 0) lignes.push(`critère(s) ${inconnus.join(", ")} : n'existe(nt) pas dans le contrat`);
  for (const n of mensonges) {
    const e = parNumero.get(n)!;
    lignes.push(
      `critère ${n} déclaré réussi mais VU EN ÉCHEC par le harnais — ${e.preuve?.observe ?? ""}` +
        (e.preuve?.erreur ? ` — erreur : ${e.preuve.erreur}` : ""),
    );
  }
  for (const e of echecs) {
    if (mensonges.includes(e.n)) continue;
    lignes.push(
      `critère ${e.n} en échec — ${e.preuve?.observe ?? ""}` +
        (e.preuve?.erreur ? ` — erreur : ${e.preuve.erreur}` : ""),
    );
  }
  for (const e of nonVerifies) lignes.push(`critère ${e.n} non vérifié — ${e.preuve?.observe ?? "pas encore exécuté"}`);

  if (lignes.length > 0) {
    return {
      accepte: false,
      mensonges,
      motif: `done REFUSÉ : ${lignes.join(" ; ")}. Corrige, puis réessaie.`,
    };
  }
  return {
    accepte: true,
    mensonges: [],
    motif: `done accepté : ${etats.length} critère(s) sur ${etats.length} vérifié(s) par exécution`,
  };
}

/** Compte « vérifiés / total » d'un état, pour l'écran et la trace. */
export function compteVerifies(etats: EtatCritere[]): { ok: number; total: number } {
  return { ok: etats.filter((e) => e.etat === "ok").length, total: etats.length };
}

/**
 * LE RAPPORT FINAL HONNÊTE — ce que l'utilisateur lit quand la boucle s'arrête
 * sans `done` accepté. Pas de « c'est fait » : le compte exact, chaque critère
 * échoué avec son erreur réelle, chaque critère non vérifié avec la raison.
 */
export function rapportFinal(etat: EtatAchevement): string {
  const { ok, total } = compteVerifies(etat.criteres);
  const lignes: string[] = [];
  if (etat.motif) lignes.push(etat.motif);
  if (total === 0) {
    lignes.push("Aucun critère vérifiable n'a été énoncé : rien ne permet de dire que la tâche est faite.");
  } else {
    lignes.push(`${ok} critère${ok > 1 ? "s" : ""} sur ${total} vérifié${ok > 1 ? "s" : ""} par exécution.`);
    for (const e of etat.criteres) {
      if (e.etat === "ok") continue;
      const detail = e.preuve
        ? `${e.preuve.observe}${e.preuve.erreur ? ` — erreur : ${e.preuve.erreur}` : ""}`
        : "jamais vérifié";
      lignes.push(`  ${e.etat === "echec" ? "✗" : "○"} critère ${e.n} (${e.libelle}) : ${detail}`);
    }
  }
  if (etat.tronque) lignes.push("Au moins une sortie du modèle a été coupée par le budget de jetons.");
  lignes.push(`Pas utilisés : ${etat.pasUtilises} sur ${etat.plafond}.`);
  return lignes.join("\n");
}

/** Une ligne compacte « 2/3 ✓ · pas 4/6 · tronqué » pour la frise et la trace. */
export function resumeAchevement(etat: EtatAchevement): string {
  const { ok, total } = compteVerifies(etat.criteres);
  const morceaux = [
    total === 0 ? "aucun critère" : `${ok}/${total} critère${total > 1 ? "s" : ""} ✓`,
    `pas ${etat.pasUtilises}/${etat.plafond}`,
    etat.conclu ? "conclu" : "non conclu",
  ];
  if (etat.tronque) morceaux.push("sortie tronquée");
  return morceaux.join(" · ");
}
