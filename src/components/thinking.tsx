import { useEffect, useState } from "react";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import type { PasAgent } from "@/ai/agent";
import type { EtatAchevement } from "@/ai/achevement";
import { cn } from "@/lib/utils";
import { Timeline } from "./timeline";

// PLACEHOLDERS SUPPRIMÉS.
//
// Le bloc affichait en boucle des étapes techniques INVENTÉES pendant l'attente :
// « Prefill on UFS… », « Prerouter selecting experts… », « Planning tool calls… ».
// Aucune n'a lieu : il n'y a pas de « prerouter », pas de sélection d'experts
// par un routeur maison, et « Prefill on UFS » n'était lu nulle part. C'était de
// l'instrumentation décorative qui se faisait passer pour l'activité réelle du
// moteur. À la place, une ligne VRAIE : on attend le premier jeton.
//
// LISTE D'OUTILS REMPLACÉE PAR LA FRISE (timeline.tsx). L'ancienne liste ne
// montrait que les outils exécutés, avec un résultat coupé à 200 caractères :
// un pas coupé par n_predict, un contrat refusé, un `done` sans preuve n'y
// apparaissaient pas. La frise montre CHAQUE appel au moteur avec ses chiffres
// réels et sa raison d'arrêt — la même donnée que la ligne de trace.

const ATTENTE = "en attente du premier jeton…";

export function ThinkingBlock({
  thinking,
  brouillon,
  pas,
  achevement,
  live,
}: {
  thinking?: string;
  /** Sortie brute du pas en cours (contrat, décision), en flux. */
  brouillon?: string;
  pas?: PasAgent[];
  achevement?: EtatAchevement;
  live: boolean;
}) {
  const hasPas = (pas?.length ?? 0) > 0;
  const hasText = Boolean(thinking?.trim());
  const hasBrouillon = live && Boolean(brouillon?.trim());
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);

  if (!live && !hasText && !hasPas && !achevement) return null;

  const label = live ? "Travail en cours" : hasPas ? `${pas!.length} appel${pas!.length > 1 ? "s" : ""} au moteur` : "Travail";

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border bg-elevated">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {live ? (
          <LoaderCircle className="size-3.5 animate-spin text-muted" strokeWidth={2} />
        ) : (
          <Check className={cn("size-3.5", achevement && !achevement.conclu ? "text-hot" : "text-ok")} strokeWidth={2} />
        )}
        <span className={cn("flex-1 text-xs font-medium", live ? "think-shimmer" : "text-muted")}>
          {label}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 text-subtle transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
          strokeWidth={2}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {live && !hasText && !hasPas && !hasBrouillon && (
            <p className="font-mono text-xs text-muted">{ATTENTE}</p>
          )}
          {hasText && (
            <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">
              {thinking}
            </p>
          )}
          {hasBrouillon && (
            <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-stat/80">
              {brouillon!.slice(-600)}
            </pre>
          )}
          {(hasPas || achevement) && <Timeline pas={pas ?? []} achevement={achevement} live={live} />}
        </div>
      )}
    </div>
  );
}
