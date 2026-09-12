/**
 * RÉGLAGES DU MOTEUR — le contexte en premier.
 *
 * POURQUOI CE PANNEAU EXISTE : le contexte était figé à 4096 jetons, et c'est
 * exactement le réglage qui décide si un gros modèle TIENT en mémoire. Sur le
 * 30B-A3B, chaque millier de jetons de contexte coûte 96 Mo de cache KV ; passer
 * de 8192 à 2048 libère près de 600 Mo, ce qui peut être la différence entre
 * « le modèle charge » et « l'application est tuée par le système ».
 *
 * Les valeurs affichées ne sont pas des estimations : le cache KV est calculé
 * depuis les paramètres réels du modèle (`attention.head_count_kv`,
 * `block_count`, dimensions de tête — lus dans les en-têtes GGUF, voir
 * `reglages.ts`).
 *
 * LE PANNEAU N'EST PAS POSÉ SUR LE CHAMP DE SAISIE : il s'insère sous l'en-tête,
 * au-dessus de la conversation, pour ne jamais recouvrir ce qui sert à écrire.
 */
import { useState } from "react";
import { RotateCw, X } from "lucide-react";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";
import {
  CHOIX_CONTEXTE,
  CHOIX_LOT,
  CHOIX_THREADS,
  memoireKVOctets,
  memoireTotaleOctets,
  type ReglagesMoteur as Reglages,
} from "@/ai/reglages";
import { modeleGguf } from "@/ai/moteurNatif";
import type { LocalModelId } from "@/ai/types";

function lisible(octets: number): string {
  if (octets >= 1e9) return `${(octets / 1e9).toFixed(2).replace(".", ",")} Go`;
  return `${Math.round(octets / 1e6)} Mo`;
}

function Boutons<T extends number>({
  valeurs,
  valeur,
  surChoix,
  etiquette,
  rendre,
}: {
  valeurs: readonly T[];
  valeur: number;
  surChoix: (v: T) => void;
  etiquette: string;
  rendre: (v: T) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted">{etiquette}</span>
      <div className="flex rounded-full bg-elevated p-0.5">
        {valeurs.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => surChoix(v)}
            className={cn(
              "min-w-9 rounded-full px-2 py-1 font-mono text-[11px] font-medium",
              valeur === v ? "bg-bubble text-fg" : "text-muted",
            )}
          >
            {rendre(v)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReglagesMoteur() {
  const modeleId = useSession((s) => s.model) as LocalModelId;
  const enregistres = useSession((s) => s.reglages);
  const setReglages = useSession((s) => s.setReglages);
  const fermer = useSession((s) => s.basculerReglages);
  const streaming = useSession((s) => s.streaming);
  const [choisis, setChoisis] = useState<Reglages>(enregistres);

  const modele = modeleGguf(modeleId);
  const kv = memoireKVOctets(modele, choisis.nCtx);
  const total = memoireTotaleOctets(modele, choisis.nCtx);
  const change = JSON.stringify(choisis) !== JSON.stringify(enregistres);

  return (
    <div
      data-testid="reglages-moteur"
      className="mx-3 mb-2 shrink-0 rounded-xl border border-white/10 bg-elevated/60 px-3 py-2 font-sans"
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-fg">Réglages du moteur</p>
        <button
          type="button"
          onClick={() => fermer(false)}
          className="flex size-6 items-center justify-center rounded-full text-muted"
          aria-label="Fermer les réglages"
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Boutons
          valeurs={CHOIX_CONTEXTE}
          valeur={choisis.nCtx}
          surChoix={(nCtx) => setChoisis({ ...choisis, nCtx })}
          etiquette="Contexte (jetons)"
          rendre={(v) => (v >= 1024 ? `${v / 1024}k` : String(v))}
        />
        <Boutons
          valeurs={CHOIX_LOT}
          valeur={choisis.nBatch}
          surChoix={(nBatch) => setChoisis({ ...choisis, nBatch })}
          etiquette="Lot de pré-remplissage"
          rendre={(v) => String(v)}
        />
        <Boutons
          valeurs={CHOIX_THREADS}
          valeur={choisis.nThreads}
          surChoix={(nThreads) => setChoisis({ ...choisis, nThreads })}
          etiquette="Threads de calcul"
          rendre={(v) => (v === 0 ? "auto" : String(v))}
        />
      </div>

      <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted">
        cache KV {lisible(kv)} · poids {lisible(modele.octets)} → {lisible(total)} à tenir en mémoire
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted text-pretty">
        Le contexte est la mémoire de travail du modèle : la conversation, le prompt système et les
        résultats d&apos;outils doivent y tenir. Le baisser libère de la mémoire ; le monter permet
        des échanges plus longs.
      </p>

      <button
        type="button"
        disabled={!change || streaming}
        onClick={() => setReglages(choisis)}
        className={cn(
          "mt-2 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium",
          change && !streaming ? "bg-primary text-primary-fg" : "bg-bubble text-muted",
        )}
      >
        <RotateCw className="size-3.5" strokeWidth={2} />
        {change ? "Enregistrer et recharger le moteur" : "Réglages enregistrés"}
      </button>
    </div>
  );
}
