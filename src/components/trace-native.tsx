/**
 * AFFICHE LA TRACE DU NATIF À L'ÉCRAN (voir `src/ai/traceNatif.ts`).
 *
 * POURQUOI UN PANNEAU, ET PAS SEULEMENT UN FICHIER : le fichier de trace est
 * dans la mémoire privée de l'appli (`getFilesDir()`) — un gestionnaire de
 * fichiers ne peut PAS l'ouvrir, et l'appareil visé n'a ni `adb` ni rapport de
 * bug exportable. Le seul lecteur disponible, c'est donc l'appli elle-même :
 * ce panneau relit le fichier toutes les deux secondes et l'affiche.
 *
 * CE QU'ON Y LIT, et c'est ce qui tranche : la DERNIÈRE ligne écrite par le
 * natif nomme l'étape en cours. Si le panneau dit « aucune trace », le blocage
 * est AVANT le natif (côté Java) ; si la dernière ligne est « appel de
 * loadModel », le blocage est dans la lecture du GGUF, le contexte, le cache KV
 * ou le warmup.
 *
 * Il ne bloque rien et n'échoue jamais bruyamment : hors application native, il
 * ne s'affiche pas du tout. Le bouton « copier » sert à coller la trace dans une
 * conversation quand on ne peut pas la photographier.
 */

import { useEffect, useState } from "react";
import { dernieresLignes, lireTraceNative, type EtatTraceNative } from "@/ai/traceNatif";
import { estApplicationNative } from "@/ai/moteur";

/** Période de relecture : 2 s. La trace s'écrit par étapes, pas par jetons. */
const PERIODE_MS = 2_000;

export function TraceNative() {
  const [monte, setMonte] = useState(false);
  const [trace, setTrace] = useState<EtatTraceNative | null>(null);
  const [copie, setCopie] = useState(false);
  const [majA, setMajA] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!estApplicationNative()) return;
    setMonte(true);

    let vivant = true;
    const relire = async () => {
      const etat = await lireTraceNative();
      if (vivant) {
        setTrace(etat);
        // L'HEURE DE RELECTURE est affichée : sans elle, un panneau qui ne bouge
        // pas ne se distingue pas d'un panneau figé, et c'est exactement la
        // confusion qu'on cherche à lever.
        setMajA(new Date().toLocaleTimeString());
      }
    };
    void relire();
    const minuteur = setInterval(() => void relire(), PERIODE_MS);
    return () => {
      vivant = false;
      clearInterval(minuteur);
    };
  }, []);

  if (!monte || trace === null) return null;

  const lignes = dernieresLignes(trace, 40);
  const texte = lignes === null ? "" : lignes.join("\n");

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(texte);
      setCopie(true);
      setTimeout(() => setCopie(false), 2_000);
    } catch {
      setCopie(false);
    }
  };

  // EN HAUT, ET PAS EN BAS : le champ de saisie de l'appli est en bas, et un
  // panneau posé dessus empêcherait justement d'envoyer la demande qui déclenche
  // le chargement à observer. En haut, il ne gêne rien.
  return (
    <div
      data-testid="trace-native"
      className="fixed left-0 right-0 top-0 z-50 max-h-[28vh] overflow-auto border-b border-white/15 bg-black/85 px-3 py-2 font-mono text-[10px] leading-tight text-white/85 backdrop-blur"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-sans text-[10px] uppercase tracking-wide text-white/60">
          trace native (diagnostic){majA ? ` · relu à ${majA}` : ""}
        </span>
        {lignes !== null && lignes.length > 0 && (
          <button
            type="button"
            onClick={() => void copier()}
            className="rounded border border-white/20 px-2 py-0.5 font-sans text-[10px] text-white/80"
          >
            {copie ? "copié" : "copier"}
          </button>
        )}
      </div>

      {lignes === null ? (
        <p className="font-sans text-[11px] text-amber-300">
          aucune trace native : le fichier n&apos;existe pas, donc le moteur natif n&apos;a jamais été
          atteint (le blocage est avant lui, côté Java).
        </p>
      ) : lignes.length === 0 ? (
        <p className="font-sans text-[11px] text-amber-300">
          trace native vide : le natif a été atteint mais n&apos;a rien écrit.
        </p>
      ) : (
        <pre className="whitespace-pre-wrap break-all">{texte}</pre>
      )}
    </div>
  );
}
