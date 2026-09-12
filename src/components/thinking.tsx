import { useEffect, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Terminal, Wrench } from "lucide-react";
import { toolLabel, type ToolEvent } from "@/lib/edge0";
import { cn } from "@/lib/utils";

// PLACEHOLDERS SUPPRIMÉS.
//
// Le bloc affichait en boucle des étapes techniques INVENTÉES pendant l'attente :
// « Prefill on UFS… », « Prerouter selecting experts… », « Planning tool calls… ».
// Aucune n'a lieu : il n'y a pas de « prerouter », pas de sélection d'experts
// par un routeur maison, et « Prefill on UFS » n'était lu nulle part. C'était de
// l'instrumentation décorative qui se faisait passer pour l'activité réelle du
// moteur. À la place, une ligne VRAIE : on attend le premier jeton.

const ATTENTE = "en attente du premier jeton…";

export function ThinkingBlock({
  thinking,
  tools,
  live,
}: {
  thinking?: string;
  tools?: ToolEvent[];
  live: boolean;
}) {
  const hasTools = (tools?.length ?? 0) > 0;
  const hasText = Boolean(thinking?.trim());
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);

  if (!live && !hasText && !hasTools) return null;

  const label = live ? "Thinking" : hasTools ? "Tools" : "Thought";

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
          <Check className="size-3.5 text-ok" strokeWidth={2} />
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
        <div className="border-t border-border px-3 py-2">
          {live && !hasText && !hasTools && (
            <p className="font-mono text-xs text-muted">{ATTENTE}</p>
          )}
          {hasText && (
            <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">
              {thinking}
            </p>
          )}
          {hasTools && (
            <ul className={cn("flex flex-col gap-1.5", hasText && "mt-2")}>
              {tools!.map((t) => (
                <li key={t.id} className="flex items-start gap-2 font-mono text-xs">
                  {t.name === "run_js" ? (
                    <Terminal className="mt-0.5 size-3 shrink-0 text-stat" strokeWidth={2} />
                  ) : (
                    <Wrench className="mt-0.5 size-3 shrink-0 text-stat" strokeWidth={2} />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-fg/90">
                      {toolLabel(t.name)}
                      {t.status === "start" && live ? (
                        <span className="text-muted"> · running</span>
                      ) : (
                        <span className="text-ok"> · done</span>
                      )}
                    </p>
                    {t.name === "run_js" && t.status === "done" && t.result && (
                      <p className="mt-0.5 truncate text-muted">{t.result}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
