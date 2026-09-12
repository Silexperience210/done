/**
 * PONT ENTRE L'APERÇU (iframe) ET L'APPLI — la vérification là où le code tourne.
 *
 * LE CONSTAT (C3 du brainstorm) : le script d'une app écrite par le modèle
 * était « vérifié » dans un Web Worker — sans `document`, sans `window`, sans
 * canvas. Toute app réelle y produisait « document is not defined », et cette
 * erreur FAUSSE partait au modèle comme une vraie. Pendant ce temps l'iframe
 * où le code tournait vraiment ne remontait rien : ni `onerror`, ni console.
 *
 * Ce module injecte dans le HTML de l'aperçu un petit script, PREMIER dans le
 * document, qui remonte au parent par `postMessage` :
 *  - `window.onerror` et `unhandledrejection` (message, ligne, colonne) ;
 *  - `console.error` / `console.warn` / `console.log` (message, et la position
 *    du point d'appel lue dans la pile quand le moteur JS la donne) ;
 *  - un signal de FIN DE CHARGEMENT (`load`) ;
 *  - la RÉPONSE aux demandes d'évaluation du parent (`studio:eval`) : c'est
 *    ainsi qu'un critère `run_js` du contrat s'exécute DANS l'app, avec ses
 *    fonctions et son DOM, et non dans un Worker aveugle.
 *
 * Chaque message porte le NUMÉRO DE VERSION du document qui l'a émis : quand
 * l'app est réécrite, les messages tardifs de l'ancienne version ne polluent
 * pas le verdict de la nouvelle.
 *
 * L'iframe est `sandbox="allow-scripts"` sans `allow-same-origin` : son origine
 * est opaque (« null »), donc `parent.postMessage(…, "*")` est la seule voie —
 * et elle marche. Le parent ne se fie pas à l'origine : il reconnaît la
 * SOURCE (`source: "studio-apercu"`) et la version.
 *
 * Tout ici est PUR (des chaînes et des objets) : la partie qui écoute la
 * fenêtre vit dans le store (`src/store/apercu.ts`).
 */

/** Marqueur des messages émis par le pont : ce qui les distingue de tout autre `postMessage`. */
export const SOURCE_PONT = "studio-apercu";

export type NiveauConsole = "error" | "warn" | "log";

/** Une ligne de la console de l'aperçu, telle qu'elle est affichée et journalisée. */
export type EntreeConsole = {
  niveau: NiveauConsole;
  message: string;
  /** Ligne / colonne dans le document de l'app ; `null` quand le moteur JS ne les donne pas. */
  ligne: number | null;
  colonne: number | null;
  /** Horodatage RÉEL de l'évènement dans l'iframe (ms). */
  ts: number;
  /** Version du document qui l'a émis. */
  version: number;
};

export type MessageApercu =
  | { type: "console"; version: number; entree: EntreeConsole }
  | { type: "charge"; version: number; ts: number }
  | { type: "eval"; version: number; id: string; ok: boolean; valeur: string | null; erreur: string | null };

/**
 * LE SCRIPT INJECTÉ. Écrit en JavaScript brut (pas de TypeScript : il tourne
 * dans l'iframe, tel quel). Il ne dépend de rien, ne touche pas au DOM, et ne
 * lève jamais : un pont qui casserait l'app fabriquerait des erreurs.
 *
 * La position d'un `console.*` est lue dans la pile d'une `Error` créée sur
 * place : sur Chrome/WebView, les cadres ressemblent à `at f (about:srcdoc:12:5)`.
 * Les deux premiers cadres sont le pont lui-même (`pos`, puis l'enveloppe de
 * `console.*`) ; le suivant est l'appelant — vérifié dans Chromium : un
 * `console.log` en ligne 4 du document remonte « 4 ». Sans pile exploitable, la
 * position reste `null` — jamais un « 0:0 » inventé.
 */
export function scriptPont(version: number): string {
  const v = Math.max(0, Math.floor(version));
  return (
    "<script>(function(){" +
    `var V=${v},S=${JSON.stringify(SOURCE_PONT)};` +
    "function env(m){try{m.source=S;m.version=V;parent.postMessage(m,'*')}catch(e){}}" +
    // Pile : [0] « Error », [1] pos(), [2] l'enveloppe console.* du pont, [3] l'APPELANT.
    "function pos(){try{var l=String(new Error().stack||'').split('\\n');for(var i=3;i<l.length;i++){var m=/:(\\d+):(\\d+)\\)?\\s*$/.exec(l[i]);if(m)return[+m[1],+m[2]]}}catch(e){}return[null,null]}" +
    "function txt(a){var o=[];for(var i=0;i<a.length;i++){var x=a[i];try{o.push(x instanceof Error?(x.name+': '+x.message):typeof x==='object'?JSON.stringify(x):String(x))}catch(e){o.push(String(x))}}return o.join(' ')}" +
    "function con(n,m,l,c){env({type:'console',niveau:n,message:m,ligne:l,colonne:c,ts:Date.now()})}" +
    "window.addEventListener('error',function(e){con('error',String(e.message||e.error||'erreur'),typeof e.lineno==='number'&&e.lineno>0?e.lineno:null,typeof e.colno==='number'&&e.colno>0?e.colno:null)});" +
    "window.addEventListener('unhandledrejection',function(e){var r=e.reason;con('error','Promesse rejetée : '+(r&&r.message?r.name+': '+r.message:String(r)),null,null)});" +
    "['error','warn','log'].forEach(function(n){var o=console[n];console[n]=function(){var p=pos();con(n,txt(arguments),p[0],p[1]);try{o.apply(console,arguments)}catch(e){}}});" +
    "window.addEventListener('load',function(){env({type:'charge',ts:Date.now()})});" +
    "window.addEventListener('message',function(e){var d=e.data;if(!d||d.type!=='studio:eval'||typeof d.code!=='string')return;var id=String(d.id);" +
    "function fin(ok,val,err){env({type:'eval',id:id,ok:ok,valeur:ok?String(val):null,erreur:ok?null:String(err)})}" +
    "try{var r=(0,eval)(d.code);if(r&&typeof r.then==='function'){r.then(function(x){fin(true,x===undefined?'undefined':x,null)},function(x){fin(false,null,x&&x.message?x.name+': '+x.message:x)})}else{fin(true,r===undefined?'undefined':r,null)}}" +
    "catch(x){fin(false,null,x&&x.message?x.name+': '+x.message:x)}});" +
    "})();</script>"
  );
}

/**
 * Injecte le pont EN PREMIER dans le document : juste après `<head…>`, sinon
 * juste après `<html…>`, sinon en tête du fragment. Il doit précéder tout
 * script de l'app pour en attraper les erreurs — y compris de syntaxe.
 */
export function injecterPont(html: string, version: number): string {
  const script = scriptPont(version);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  const racine = /<html[^>]*>/i.exec(html);
  if (racine) return html.slice(0, racine.index + racine[0].length) + script + html.slice(racine.index + racine[0].length);
  return script + html;
}

function entier(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/**
 * Lit un `MessageEvent.data` : rend le message du pont, ou `null` pour tout ce
 * qui n'en est pas un (autres `postMessage` de la page, formes inattendues).
 * Strict sur la forme : un champ manquant ou d'un mauvais type disqualifie le
 * message, on ne complète rien.
 */
export function lireMessageApercu(data: unknown): MessageApercu | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.source !== SOURCE_PONT) return null;
  const version = typeof d.version === "number" && Number.isFinite(d.version) ? Math.floor(d.version) : null;
  if (version === null) return null;
  if (d.type === "charge") {
    return { type: "charge", version, ts: typeof d.ts === "number" ? d.ts : Date.now() };
  }
  if (d.type === "console") {
    const niveau = d.niveau === "error" || d.niveau === "warn" || d.niveau === "log" ? d.niveau : null;
    if (niveau === null || typeof d.message !== "string") return null;
    return {
      type: "console",
      version,
      entree: {
        niveau,
        message: d.message,
        ligne: entier(d.ligne),
        colonne: entier(d.colonne),
        ts: typeof d.ts === "number" ? d.ts : Date.now(),
        version,
      },
    };
  }
  if (d.type === "eval") {
    if (typeof d.id !== "string" || typeof d.ok !== "boolean") return null;
    return {
      type: "eval",
      version,
      id: d.id,
      ok: d.ok,
      valeur: typeof d.valeur === "string" ? d.valeur : null,
      erreur: typeof d.erreur === "string" ? d.erreur : null,
    };
  }
  return null;
}

/** Une entrée de console rendue en une ligne, la même à l'écran et pour le modèle. */
export function ligneConsole(e: EntreeConsole): string {
  const position = e.ligne !== null ? ` (ligne ${e.ligne}${e.colonne !== null ? `:${e.colonne}` : ""})` : "";
  return `${e.niveau === "error" ? "ERREUR" : e.niveau === "warn" ? "avert." : "log"} : ${e.message}${position}`;
}
