/**
 * LA FRISE DES PAS D'AGENT — ce qui s'est passé, pas ce qu'on aurait aimé.
 *
 * Elle remplace la liste d'outils tronquée du bloc de réflexion : une ligne par
 * appel au moteur, avec le pas, la phase, l'outil, les jetons (produits/budget),
 * les durées de pré-remplissage et de décodage, la RAISON D'ARRÊT et le verdict
 * — puis l'état des critères d'achèvement. Chaque ligne lit le MÊME `PasAgent`
 * que la ligne écrite dans le journal (`ligneTracePas`), donc les deux disent la
 * même chose ; on peut dérouler une ligne pour lire la sortie brute du moteur
 * et ce qui lui a été renvoyé.
 *
 * RÈGLE D'AFFICHAGE : un chiffre absent s'écrit « — ». Jamais un 0 à la place
 * d'une mesure qui n'existe pas, jamais d'animation qui simule un progrès.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { PasAgent, Verdict } from "@/ai/agent";
import type { EtatAchevement, EtatCritere } from "@/ai/achevement";
import { resumeAchevement } from "@/ai/achevement";
import { cn } from "@/lib/utils";

function tiret(v: number | null | undefined, suffixe = ""): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v}${suffixe}` : "—";
}

function ms(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1).replace(".", ",")} s`;
}

const LIBELLE_VERDICT: Record<Verdict, string> = {
  contrat: "contrat",
  outil: "ok",
  reponse: "texte",
  illisible: "illisible",
  tronque: "tronqué",
  refuse: "refusé",
};

function couleurVerdict(v: Verdict): string {
  if (v === "tronque" || v === "refuse") return "text-hot";
  if (v === "illisible") return "text-hot/80";
  if (v === "outil" || v === "contrat") return "text-ok";
  return "text-muted";
}

const LIBELLE_RAISON: Record<string, string> = {
  eos: "fin",
  limite: "limite",
  chaine: "chaîne",
  contexte_plein: "ctx plein",
  interrompu: "interrompu",
  inconnue: "—",
};

export function Timeline({ pas, achevement, live }: { pas: PasAgent[]; achevement?: EtatAchevement; live: boolean }) {
  if (pas.length === 0 && !achevement) return null;
  return (
    <div className="flex flex-col gap-1">
      {pas.length > 0 && (
        <ol className="flex flex-col divide-y divide-border/60 rounded-md border border-border/60">
          {pas.map((p) => (
            <LignePas key={p.id} p={p} />
          ))}
        </ol>
      )}
      {achevement && <Achevement etat={achevement} live={live} />}
    </div>
  );
}

function LignePas({ p }: { p: PasAgent }) {
  const [ouvert, setOuvert] = useState(false);
  const b = p.bilan;
  return (
    <li className="font-mono text-[11px] leading-snug">
      <button
        type="button"
        onClick={() => setOuvert((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left tabular-nums"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 text-subtle transition-transform duration-150", ouvert && "rotate-90")}
          strokeWidth={2}
        />
        <span className="w-8 shrink-0 text-muted">p{p.pas}</span>
        <span className="w-16 shrink-0 text-fg/80">{p.phase === "decision" ? "décision" : p.phase}</span>
        <span className="w-20 shrink-0 truncate text-stat">{p.outil ?? "—"}</span>
        <span className="w-16 shrink-0 text-muted" title="jetons produits / budget">
          {tiret(b?.jetonsPredits)}/{p.budget}
        </span>
        <span className="w-24 shrink-0 text-muted" title="pré-remplissage · décodage">
          {ms(b?.msPreremplissage)} · {ms(b?.msDecodage)}
        </span>
        <span className="w-14 shrink-0 text-muted" title="raison d'arrêt du moteur">
          {b ? LIBELLE_RAISON[b.raison] ?? b.raison : "—"}
        </span>
        <span className={cn("shrink-0 font-medium", couleurVerdict(p.verdict))}>{LIBELLE_VERDICT[p.verdict]}</span>
      </button>
      {ouvert && (
        <div className="flex flex-col gap-1.5 border-t border-border/40 bg-surface/60 px-2 py-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted">
            <dt>prompt</dt>
            <dd className="text-fg/80">{tiret(b?.jetonsPrompt, " jetons")}</dd>
            <dt>réglages</dt>
            <dd className="text-fg/80">
              n_ctx {tiret(b?.nCtx)} · lot {tiret(b?.nBatch)} · threads {tiret(b?.nThreads)}
            </dd>
            <dt>appel</dt>
            <dd className="text-fg/80">{ms(p.dureeMs)}</dd>
            {b?.chaineArret && (
              <>
                <dt>chaîne d'arrêt</dt>
                <dd className="text-fg/80">{b.chaineArret}</dd>
              </>
            )}
            {b?.promptTronque && (
              <>
                <dt>prompt</dt>
                <dd className="text-hot">TRONQUÉ par n_ctx</dd>
              </>
            )}
          </dl>
          {p.sortie.trim() && (
            <div>
              <p className="text-subtle">sortie du moteur</p>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all text-stat">
                {p.sortie.length > 1200 ? `${p.sortie.slice(0, 1200)}\n… (${p.sortie.length} caractères)` : p.sortie}
              </pre>
            </div>
          )}
          {p.resultat.trim() && (
            <div>
              <p className="text-subtle">renvoyé au modèle</p>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all text-muted">
                {p.resultat.length > 800 ? `${p.resultat.slice(0, 800)}…` : p.resultat}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function marque(c: EtatCritere): { symbole: string; classe: string } {
  if (c.etat === "ok") return { symbole: "✓", classe: "text-ok" };
  if (c.etat === "echec") return { symbole: "✗", classe: "text-hot" };
  return { symbole: "○", classe: "text-subtle" };
}

/** L'état d'achèvement du tour : critères ✓/✗/○, pas utilisés, tronqué, conclu ou non. */
export function Achevement({ etat, live }: { etat: EtatAchevement; live: boolean }) {
  return (
    <div className="rounded-md border border-border/60 px-2 py-1.5 font-mono text-[11px] leading-snug">
      <p className={cn("font-medium", etat.conclu ? "text-ok" : live ? "text-muted" : "text-hot")}>
        {resumeAchevement(etat)}
      </p>
      {etat.criteres.length > 0 && (
        <ol className="mt-1 flex flex-col gap-0.5">
          {etat.criteres.map((c) => {
            const m = marque(c);
            return (
              <li key={c.n} className="flex gap-2">
                <span className={cn("w-3 shrink-0", m.classe)}>{m.symbole}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-fg/85">
                    {c.n}. {c.libelle}
                  </p>
                  {c.preuve && (
                    <p className="truncate text-muted" title={c.preuve.erreur ?? c.preuve.observe}>
                      {c.preuve.observe}
                      {c.preuve.erreur ? ` — ${c.preuve.erreur}` : ""}
                      {` · ${ms(c.preuve.ms)}`}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {etat.motif && !etat.conclu && <p className="mt-1 text-hot/90">{etat.motif}</p>}
    </div>
  );
}
