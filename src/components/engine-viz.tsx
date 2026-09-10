import { useEffect, useMemo, useState } from "react";
import { MODELS, type ModelId } from "@/lib/edge0";
import { cn } from "@/lib/utils";

function useNow(active: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const start = performance.now();
    const loop = (now: number) => {
      setT(now - start);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return t;
}

export function ExpertGrid({
  model,
  streaming,
}: {
  model: ModelId;
  streaming: boolean;
}) {
  const t = useNow(true);
  const profile = MODELS[model];
  const cols = 16;
  const rows = 7;
  const cells = rows * cols;
  const hot = useMemo(() => {
    const set = new Set<number>();
    const step = Math.floor(t / (streaming ? 90 : 420));
    for (let k = 0; k < profile.topK; k++) {
      const seed = (step * 17 + k * 41 + profile.layers) % cells;
      set.add(seed);
      set.add((seed + 9) % cells);
    }
    return set;
  }, [t, streaming, profile.topK, profile.layers, cells]);

  return (
    <div
      className="grid gap-px"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      aria-hidden
    >
      {Array.from({ length: cells }, (_, i) => {
        const on = hot.has(i);
        return (
          <span
            key={i}
            className={cn("aspect-square rounded-full", on ? "bg-hot" : "bg-fg/12")}
            style={{ opacity: on ? (streaming ? 1 : 0.55) : 0.35 }}
          />
        );
      })}
    </div>
  );
}

export function EnginePanel({
  model,
  streaming,
  memoryGb,
  tokPerSec,
}: {
  model: ModelId;
  streaming: boolean;
  memoryGb: number;
  tokPerSec: number;
}) {
  const profile = MODELS[model];
  const memPct = Math.min(100, (memoryGb / profile.peakGb) * 100);

  return (
    <aside className="flex w-full max-w-sm flex-col gap-3">
      <div className="rounded-xl border border-border bg-elevated p-3.5">
        <div className="mb-2.5 flex items-baseline justify-between">
          <span className="text-xs font-medium tracking-wide text-muted uppercase">
            Active experts
          </span>
          <span className="font-mono text-xs text-stat tabular-nums">
            K={profile.topK} / {profile.experts}
          </span>
        </div>
        <ExpertGrid model={model} streaming={streaming} />
        <div className="mt-2.5 flex items-center justify-between text-xs text-muted">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <i className="size-1.5 rounded-full bg-hot" />
              RAM
            </span>
            <span className="flex items-center gap-1.5">
              <i className="size-1.5 rounded-full bg-fg/20" />
              UFS
            </span>
          </span>
          <span className="font-mono tabular-nums">
            {memoryGb.toFixed(2)} GB · {tokPerSec.toFixed(1)} tok/s
          </span>
        </div>
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-fg/10">
          <div
            className="h-full rounded-full bg-ok transition-[width] duration-200"
            style={{ width: `${memPct}%` }}
          />
        </div>
      </div>
    </aside>
  );
}
