import { useEffect, useMemo, useState } from "react";
import { MODELS, type ModelId } from "@/lib/edge0";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";

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

/**
 * Activité du moteur — barre d'occupation, pas de fiction.
 *
 * Ce panneau montrait auparavant une grille de « experts actifs (K=4 / 256) »
 * qui n'existait pas : aucun modèle à experts ne tourne dans cette application.
 * Il montre maintenant le modèle réellement chargé, l'appareil qui l'exécute et
 * le débit mesuré.
 */
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
  const engine = useSession((s) => s.engine);
  const engineNote = useSession((s) => s.engineNote);
  const t = useNow(streaming);

  // Petite respiration visuelle quand le moteur travaille (aucune prétention
  // technique : c'est un témoin d'activité, pas une visualisation d'experts).
  const bars = useMemo(() => {
    const n = 28;
    const phase = Math.floor(t / (streaming ? 70 : 400));
    return Array.from({ length: n }, (_, i) => {
      const wave = Math.sin((i + phase) * 0.55) * 0.5 + 0.5;
      return streaming ? 0.25 + wave * 0.75 : 0.16 + wave * 0.14;
    });
  }, [t, streaming]);

  return (
    <aside className="flex w-full max-w-sm flex-col gap-3">
      <div className="rounded-xl border border-border bg-elevated p-3.5">
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <span className="text-xs font-medium tracking-wide text-muted uppercase">
            Modèle local
          </span>
          <span className="truncate font-mono text-xs text-stat">{profile.name}</span>
        </div>

        <div className="flex h-8 items-end gap-px" aria-hidden>
          {bars.map((v, i) => (
            <span
              key={i}
              className={cn("flex-1 rounded-sm", streaming ? "bg-hot" : "bg-fg/20")}
              style={{ height: `${Math.round(v * 100)}%` }}
            />
          ))}
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted">Exécution</dt>
          <dd className="text-right font-mono text-stat">
            {engine === "chargement"
              ? "chargement"
              : engine === "erreur"
                ? "indisponible"
                : engine === "pret"
                  ? "sur l'appareil"
                  : "au repos"}
          </dd>
          <dt className="text-muted">Appareil</dt>
          {/* Pas de repli « llama.cpp (natif) » : quand rien n'est chargé, on ne
              prétend pas connaître le backend — on écrit « — ». */}
          <dd className="text-right font-mono text-stat">
            {engineNote ? engineNote.split(" · ")[0] : "—"}
          </dd>
          <dt className="text-muted">Débit mesuré</dt>
          <dd className="text-right font-mono tabular-nums text-stat">
            {tokPerSec > 0 ? `${tokPerSec.toFixed(1)} tok/s` : "—"}
          </dd>
          <dt className="text-muted">Paramètres</dt>
          <dd className="text-right font-mono text-stat">{profile.params}</dd>
          {/* Poids RÉEL du fichier (voir MODELS) — pas une mesure de la RAM
              occupée, donc étiqueté « poids » et pas « mémoire ». */}
          <dt className="text-muted">Poids du modèle</dt>
          <dd className="text-right font-mono tabular-nums text-stat">{memoryGb.toFixed(2)} Go</dd>
          <dt className="text-muted">Réseau</dt>
          {/* « aucun » était FAUX : le premier lancement télécharge le GGUF. */}
          <dd className="text-right font-mono text-stat">aucun (hors téléchargement)</dd>
        </dl>

        {/* Barre de mémoire SUPPRIMÉE : elle remplissait un ratio inventé
            (poids réel / « pointe » fabriquée). Il n'y a pas de budget mesuré à
            montrer, donc on n'en dessine aucun. */}
        {engineNote ? (
          <p className="mt-2 font-mono text-[11px] leading-snug text-muted">{engineNote}</p>
        ) : (
          <p className="mt-2 font-mono text-[11px] leading-snug text-muted">{profile.note}</p>
        )}
      </div>
    </aside>
  );
}
