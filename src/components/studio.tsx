/**
 * LE STUDIO — l'app produite, là où elle tourne vraiment, et tout ce qu'on peut
 * en dire sans rien inventer.
 *
 * Quatre onglets :
 *  - APERÇU : l'iframe (`sandbox="allow-scripts"`) où l'app s'exécute. Le pont
 *    injecté dans son HTML (pontApercu.ts) remonte les erreurs réelles et le
 *    signal de chargement ; le composant enregistre la fenêtre de l'iframe pour
 *    que le store puisse y exécuter les critères du contrat ;
 *  - CODE : l'HTML brut du modèle, en flux pendant la production ; quand il y a
 *    plusieurs versions, le diff LCS entre deux d'entre elles (ce que la
 *    correction a changé) ; une version tronquée est marquée telle quelle ;
 *  - CONSOLE : les erreurs, avertissements et logs émis par l'app dans l'iframe,
 *    horodatés, avec ligne et colonne quand le moteur JS les donne, et un
 *    bouton pour recharger l'aperçu (réessai) ;
 *  - HISTORIQUE : les apps conservées sur l'appareil, rechargeables sans modèle,
 *    copie du code et export .html.
 *
 * Pas de coloration syntaxique lourde : l'interface et llama.cpp partagent les
 * cœurs, et le décodage est ce qui compte pendant qu'une app s'écrit.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Code2, Copy, Download, History, Play, RotateCw, Terminal, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession, type StudioState, type StudioTab, type VersionStudio } from "@/store/session";
import { enregistrerFenetreApercu } from "@/store/apercu";
import { diffLignes, resumeDiff } from "@/ai/diff";
import { ligneConsole, type EntreeConsole } from "@/ai/pontApercu";
import { exporterHtml, type AppEnregistree } from "@/ai/historique";
import { estApplicationNative } from "@/ai/moteur";

export function StudioPanel() {
  const studio = useSession((s) => s.studio);
  const tab = useSession((s) => s.studioTab);
  const setTab = useSession((s) => s.setStudioTab);

  return (
    <section className="flex h-phone w-full min-w-0 max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-elevated">
      <StudioChrome title={studio?.title ?? "Studio"} tab={tab} onTab={setTab} />
      <div className="relative min-h-0 flex-1">
        {studio || tab === "historique" ? (
          <StudioBody studio={studio} tab={tab} />
        ) : (
          <div className="flex h-full flex-col justify-end p-5">
            <p className="text-sm text-muted text-pretty">
              Demande au modèle local un jeu ou une page. Le code arrive ici, s'exécute sur l'appareil, et
              chaque erreur réelle de l'app est visible dans la console.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export function StudioOverlay() {
  const studio = useSession((s) => s.studio);
  const tab = useSession((s) => s.studioTab);
  const setTab = useSession((s) => s.setStudioTab);
  const close = useSession((s) => s.closeStudio);
  if (!studio && tab !== "historique") return null;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-screen">
      <div className="flex items-center gap-1 px-2 py-2">
        <button
          type="button"
          onClick={close}
          className="flex size-10 items-center justify-center rounded-full text-fg"
          aria-label="Fermer le studio"
        >
          <X className="size-5" strokeWidth={1.75} />
        </button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{studio?.title ?? "Historique"}</p>
      </div>
      <div className="px-3 pb-2">
        <TabSwitch tab={tab} onTab={setTab} />
      </div>
      <div className="relative min-h-0 flex-1">
        <StudioBody studio={studio} tab={tab} />
      </div>
    </div>
  );
}

function StudioChrome({ title, tab, onTab }: { title: string; tab: StudioTab; onTab: (t: StudioTab) => void }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
      <div className="min-w-0">
        <p className="font-mono text-xs tracking-widest text-muted uppercase">Studio</p>
        <p className="truncate text-sm font-medium text-fg">{title}</p>
      </div>
      <TabSwitch tab={tab} onTab={onTab} />
    </header>
  );
}

function TabSwitch({ tab, onTab }: { tab: StudioTab; onTab: (t: StudioTab) => void }) {
  const erreurs = useSession((s) => {
    const version = s.studio?.version ?? -1;
    return s.console.filter((e) => e.version === version && e.niveau === "error").length;
  });
  return (
    <div className="flex rounded-full bg-surface p-0.5">
      {(
        [
          { id: "preview", label: "Aperçu", Icon: Play },
          { id: "code", label: "Code", Icon: Code2 },
          { id: "console", label: "Console", Icon: Terminal },
          { id: "historique", label: "Historique", Icon: History },
        ] as const
      ).map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onTab(id)}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium",
            tab === id ? "bg-bubble text-fg" : "text-muted",
          )}
        >
          <Icon className="size-3" strokeWidth={2} />
          {label}
          {id === "console" && erreurs > 0 && (
            <span className="rounded-full bg-hot/20 px-1.5 font-mono text-[10px] text-hot tabular-nums">{erreurs}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function StudioBody({ studio, tab }: { studio: StudioState | null; tab: StudioTab }) {
  return (
    <>
      {studio && studio.htmlApercu && <Apercu html={studio.htmlApercu} version={studio.version} visible={tab === "preview"} />}
      {tab === "code" && studio && <OngletCode studio={studio} />}
      {tab === "console" && <OngletConsole version={studio?.version ?? null} />}
      {tab === "historique" && <OngletHistorique />}
      {tab === "preview" && studio && !studio.htmlApercu && (
        <pre className="absolute inset-0 overflow-auto p-4 font-mono text-xs leading-relaxed text-stat">
          {studio.enCours ?? ""}
        </pre>
      )}
    </>
  );
}

/**
 * L'IFRAME. `key={version}` la recrée à chaque nouvelle version : le document
 * repart de zéro (pas de timer ni de rAF de l'ancienne app qui survivrait), et
 * le pont porte le bon numéro. La fenêtre est enregistrée au montage pour que
 * le store puisse y poser ses questions (`studio:eval`), et retirée au démontage.
 *
 * UNE SEULE APP QUI TOURNE : la page monte DEUX arbres (la scène « bureau » et
 * la coque « téléphone »), dont un seul est affiché (`hidden` / `lg:hidden`).
 * Sans précaution, l'app tournerait dans deux iframes — deux fois le CPU
 * pendant le décodage, deux fois chaque ligne de console, deux réponses aux
 * évaluations. On ne charge donc le document QUE dans l'iframe réellement
 * rendue (largeur non nulle) ; l'autre reste `about:blank`. L'onglet Code la
 * cache par `visibility`, pas par `display` : sa largeur reste mesurable.
 */
function Apercu({ html, version, visible }: { html: string; version: number; visible: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [actif, setActif] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const rendu = el !== null && el.getBoundingClientRect().width > 0;
    setActif(rendu);
    if (rendu) enregistrerFenetreApercu(el.contentWindow);
    return () => {
      if (rendu) enregistrerFenetreApercu(null);
    };
  }, [version]);
  return (
    <iframe
      key={version}
      ref={ref}
      title="Aperçu de l'app, exécutée sur l'appareil"
      sandbox="allow-scripts"
      srcDoc={actif ? html : undefined}
      className={cn("absolute inset-0 h-full w-full border-0 bg-screen", !visible && "invisible")}
    />
  );
}

/* ─── CODE : versions, diff, copie ────────────────────────────────────── */

function OngletCode({ studio }: { studio: StudioState }) {
  const versions = studio.versions;
  const [choix, setChoix] = useState<number | null>(null);
  const [diff, setDiff] = useState(false);
  const [copie, setCopie] = useState(false);
  const courante = versions.length - 1;
  const indice = choix === null || choix > courante ? courante : choix;
  const version: VersionStudio | undefined = versions[indice];
  const precedente = indice > 0 ? versions[indice - 1] : undefined;
  const html = studio.enCours ?? version?.html ?? studio.html;
  const lignes = useMemo(
    () => (diff && precedente && version ? diffLignes(precedente.html, version.html) : null),
    [diff, precedente, version],
  );

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopie(true);
      setTimeout(() => setCopie(false), 1500);
    } catch {
      setCopie(false);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5 font-mono text-[11px]">
        {studio.enCours !== null ? (
          <span className="think-shimmer">écriture en cours · {studio.enCours.length} caractères</span>
        ) : (
          <>
            {versions.length > 1 &&
              versions.map((v, i) => (
                <button
                  key={`${v.pas}-${v.date}`}
                  type="button"
                  onClick={() => setChoix(i)}
                  className={cn(
                    "rounded-full px-2 py-0.5",
                    i === indice ? "bg-bubble text-fg" : "text-muted",
                    v.tronque && "text-hot",
                  )}
                  title={v.tronque ? "version coupée par le budget de jetons" : `pas ${v.pas}`}
                >
                  v{i + 1}
                  {v.tronque ? " ⚠" : ""}
                </button>
              ))}
            {precedente && (
              <button
                type="button"
                onClick={() => setDiff((d) => !d)}
                className={cn("rounded-full px-2 py-0.5", diff ? "bg-bubble text-fg" : "text-muted")}
              >
                diff v{indice} → v{indice + 1}
              </button>
            )}
            <span className="ml-auto flex items-center gap-2 text-muted">
              {version && (
                <span title="jetons produits pour cette version">
                  {version.jetons !== null ? `${version.jetons} jetons` : "— jetons"}
                  {version.tronque ? " · COUPÉE" : ""}
                </span>
              )}
              <button type="button" onClick={copier} className="flex items-center gap-1 text-fg/80" aria-label="Copier le code">
                <Copy className="size-3" strokeWidth={2} />
                {copie ? "copié" : "copier"}
              </button>
            </span>
          </>
        )}
      </div>
      {version?.tronque && studio.enCours === null && (
        <p className="shrink-0 border-b border-hot/30 bg-hot/10 px-3 py-1.5 font-mono text-[11px] text-hot">
          Document coupé par le budget de jetons{version.jetons !== null ? ` (${version.jetons} jetons)` : ""} : il est
          affiché tel qu'il est sorti, sans réparation.
        </p>
      )}
      {lignes ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <p className="px-3 pt-2 font-mono text-[11px] text-muted">
            {(() => {
              const r = resumeDiff(lignes);
              return `+${r.ajoutees} −${r.supprimees} · ${r.inchangees} inchangée${r.inchangees > 1 ? "s" : ""}`;
            })()}
          </p>
          <pre className="p-3 pt-1 font-mono text-xs leading-relaxed">
            {lignes.map((l, i) => (
              <div
                key={i}
                className={cn(
                  "flex gap-2 whitespace-pre-wrap break-all",
                  l.type === "+" && "bg-ok/10 text-ok",
                  l.type === "-" && "bg-hot/10 text-hot line-through decoration-hot/40",
                  l.type === "=" && "text-stat/70",
                )}
              >
                <span className="w-8 shrink-0 select-none text-right text-subtle tabular-nums">{l.b ?? l.a ?? ""}</span>
                <span className="w-3 shrink-0 select-none">{l.type === "=" ? " " : l.type}</span>
                <span className="min-w-0 flex-1">{l.texte}</span>
              </div>
            ))}
          </pre>
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-stat">{prettyHtml(html)}</pre>
      )}
    </div>
  );
}

function prettyHtml(html: string) {
  return html
    .replace(/></g, ">\n<")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

/* ─── CONSOLE : erreurs réelles de l'app ──────────────────────────────── */

function heure(ts: number): string {
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function OngletConsole({ version }: { version: number | null }) {
  const entrees = useSession((s) => s.console);
  const recharger = useSession((s) => s.rechargerApercu);
  const streaming = useSession((s) => s.streaming);
  const [toutes, setToutes] = useState(false);
  const visibles: EntreeConsole[] = toutes || version === null ? entrees : entrees.filter((e) => e.version === version);
  const erreurs = visibles.filter((e) => e.niveau === "error").length;
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fin.current?.scrollIntoView({ block: "end" });
  }, [visibles.length]);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted">
        <span className="tabular-nums">
          {visibles.length} entrée{visibles.length > 1 ? "s" : ""}
          {erreurs > 0 ? ` · ${erreurs} erreur${erreurs > 1 ? "s" : ""}` : ""}
          {version !== null ? ` · version ${version}` : ""}
        </span>
        {version !== null && (
          <button type="button" onClick={() => setToutes((t) => !t)} className={cn("rounded-full px-2 py-0.5", toutes ? "bg-bubble text-fg" : "")}>
            {toutes ? "toutes les versions" : "cette version"}
          </button>
        )}
        <button
          type="button"
          onClick={recharger}
          disabled={version === null || streaming}
          className="ml-auto flex items-center gap-1 text-fg/80 disabled:opacity-40"
          aria-label="Recharger l'aperçu"
        >
          <RotateCw className="size-3" strokeWidth={2} />
          réessayer
        </button>
      </div>
      {visibles.length === 0 ? (
        <p className="p-4 font-mono text-xs text-muted">
          {version === null
            ? "Aucune app dans le studio : rien à écouter."
            : "Aucune entrée : l'app n'a rien écrit dans la console et n'a levé aucune erreur (pour l'instant)."}
        </p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-snug">
          {visibles.map((e, i) => (
            <li
              key={`${e.ts}-${i}`}
              className={cn(
                "flex gap-2 border-b border-border/40 px-1 py-1 whitespace-pre-wrap break-all",
                e.niveau === "error" ? "text-hot" : e.niveau === "warn" ? "text-hot/70" : "text-stat/85",
              )}
            >
              <span className="shrink-0 text-subtle tabular-nums">{heure(e.ts)}</span>
              {toutes && <span className="shrink-0 text-subtle">v{e.version}</span>}
              <span className="min-w-0 flex-1">{ligneConsole(e)}</span>
            </li>
          ))}
          <div ref={fin} />
        </ol>
      )}
    </div>
  );
}

/* ─── HISTORIQUE : galerie des apps conservées ────────────────────────── */

function OngletHistorique() {
  const historique = useSession((s) => s.historique);
  const rafraichir = useSession((s) => s.rafraichirHistorique);
  const ouvrir = useSession((s) => s.ouvrirAppHistorique);
  const supprimer = useSession((s) => s.supprimerAppHistorique);
  const streaming = useSession((s) => s.streaming);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void rafraichir();
  }, [rafraichir]);

  const exporter = async (app: AppEnregistree) => {
    try {
      const ou = await exporterHtml(app, { natif: estApplicationNative() });
      setMessage(`exporté : ${ou}`);
    } catch (e) {
      // L'erreur RÉELLE, pas un « export réussi » de façade.
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const copier = async (app: AppEnregistree) => {
    try {
      await navigator.clipboard.writeText(app.html);
      setMessage(`code de « ${app.titre} » copié`);
    } catch (e) {
      setMessage(`copie impossible : ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted">
        <span className="tabular-nums">
          {historique.length} app{historique.length > 1 ? "s" : ""} conservée{historique.length > 1 ? "s" : ""} sur l'appareil
        </span>
        {message && <span className="ml-auto truncate text-fg/80">{message}</span>}
      </div>
      {historique.length === 0 ? (
        <p className="p-4 font-mono text-xs text-muted">Aucune app enregistrée pour l'instant : chaque app produite par le modèle apparaîtra ici, avec ses versions et ses mesures.</p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-auto p-2">
          {historique.map((app) => (
            <li key={app.id} className="mb-1.5 rounded-md border border-border/60 px-3 py-2">
              <div className="flex items-start gap-2">
                <button type="button" onClick={() => ouvrir(app)} disabled={streaming} className="min-w-0 flex-1 text-left disabled:opacity-50">
                  <p className="truncate text-sm font-medium text-fg">{app.titre}</p>
                  <p className="truncate text-xs text-muted">{app.question}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted tabular-nums">
                    {new Date(app.date).toLocaleString()} · {app.modele} · n_ctx {app.reglages.nCtx} · threads{" "}
                    {app.reglages.nThreads === 0 ? "auto" : app.reglages.nThreads}
                  </p>
                  <p className="font-mono text-[11px] text-muted tabular-nums">
                    {app.versions.length} version{app.versions.length > 1 ? "s" : ""} · critères {app.metriques.criteres} ·{" "}
                    {app.metriques.jetonsProduits !== null ? `${app.metriques.jetonsProduits} jetons` : "— jetons"} ·{" "}
                    {app.metriques.tokParSeconde !== null ? `${app.metriques.tokParSeconde.toFixed(1)} tok/s` : "— tok/s"} ·{" "}
                    <span className={app.metriques.conclu ? "text-ok" : "text-hot"}>{app.metriques.conclu ? "conclue" : "non conclue"}</span>
                    {app.metriques.tronque ? <span className="text-hot"> · tronquée</span> : null}
                  </p>
                </button>
                <div className="flex shrink-0 flex-col gap-1">
                  <button type="button" onClick={() => copier(app)} className="flex items-center gap-1 rounded-full bg-surface px-2 py-1 font-mono text-[11px] text-fg/80" aria-label="Copier le code">
                    <Copy className="size-3" strokeWidth={2} /> copier
                  </button>
                  <button type="button" onClick={() => exporter(app)} className="flex items-center gap-1 rounded-full bg-surface px-2 py-1 font-mono text-[11px] text-fg/80" aria-label="Exporter en .html">
                    <Download className="size-3" strokeWidth={2} /> .html
                  </button>
                  <button type="button" onClick={() => void supprimer(app.id)} className="flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[11px] text-muted" aria-label="Supprimer">
                    <Trash2 className="size-3" strokeWidth={2} /> retirer
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
