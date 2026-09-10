import { useEffect, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Terminal, Wrench } from "lucide-react";
import { toolLabel, type ToolEvent } from "@/lib/edge0";
import { cn } from "@/lib/utils";

const PLACEHOLDERS = [
  "Prefill on UFS…",
  "Prerouter selecting experts…",
  "Planning tool calls…",
];

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
  const [placeholder, setPlaceholder] = useState(PLACEHOLDERS[0]);

  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);

  useEffect(() => {
    if (!live || hasText || hasTools) return;
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % PLACEHOLDERS.length;
      setPlaceholder(PLACEHOLDERS[i]);
    }, 520);
    return () => clearInterval(id);
  }, [live, hasText, hasTools]);

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
        <span
          className={cn(
            "flex-1 text-xs font-medium",
            live ? "think-shimmer" : "text-muted",
          )}
        >
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
            <p className="font-mono text-xs text-muted">{placeholder}</p>
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
