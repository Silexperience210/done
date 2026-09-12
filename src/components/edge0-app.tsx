import { useEffect, useRef, useState } from "react";
import { ArrowUp, Code2, Play, Plus, RotateCcw, SlidersHorizontal } from "lucide-react";
import { MODELS, SUGGESTIONS, type ModelId } from "@/lib/edge0";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";
import { AndroidNav } from "./android-phone";
import { StudioOverlay } from "./studio";
import { ThinkingBlock } from "./thinking";
// L'IMPORT du modèle se fait là où il manque : dans la carte « modèle
// introuvable », pas dans un panneau de diagnostic qui n'a plus à s'afficher.
import { ImporterModele } from "./importer-modele";
// Réglages du moteur : contexte, lot, threads. Sous l'en-tête, jamais sur la saisie.
import { ReglagesMoteur } from "./reglages-moteur";

export function Edge0App({ overlay = false }: { overlay?: boolean }) {
  const {
    model,
    streaming,
    memoryGb,
    tokPerSec,
    error,
    studio,
    studioOpen,
    reglagesOuverts,
    send,
    clear,
    setModel,
    openStudio,
    setStudioTab,
  } = useSession();

  // La boucle requestAnimationFrame + tickIdle ont été RETIRÉES : elles ne
  // servaient qu'à faire osciller un chiffre de mémoire fabriqué (voir la note
  // sur tickIdle dans store/session.ts). Il n'y a plus rien à animer en continu.

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-screen">
      <Header model={model} onModel={setModel} onClear={clear} streaming={streaming} />
      {reglagesOuverts && <ReglagesMoteur />}
      <Transcript />
      <ModeleManuelCard />
      <Composer
        memoryGb={memoryGb}
        tokPerSec={tokPerSec}
        streaming={streaming}
        error={error}
        onSend={send}
        canRun={Boolean(studio)}
        onRun={() => (overlay ? openStudio("preview") : setStudioTab("preview"))}
        onCode={() => (overlay ? openStudio("code") : setStudioTab("code"))}
      />
      <AndroidNav />
      {overlay && studioOpen && <StudioOverlay />}
    </div>
  );
}

/**
 * LE CHEMIN MANUEL — affiché quand le modèle est introuvable.
 *
 * Pourquoi ce panneau existe : sur l'appareil visé, `Filesystem.downloadFile`
 * (déprécié en 8.1.3) ne démarre pas. Faire dépendre l'utilisateur de notre code
 * de téléchargement le laissait bloqué. Mais le laisser poser le GGUF dans le
 * stockage PARTAGÉ ne marche pas non plus — l'appli n'a que la permission
 * INTERNET, elle ne peut pas y lire (la trace native le montre : les
 * emplacements /sdcard/* répondent « absent »). Ce panneau donne donc les trois
 * choses nécessaires, sans jargon : le nom EXACT du fichier attendu, l'URL
 * directe à ouvrir dans Chrome, et le fait qu'il faut l'IMPORTER dans l'appli
 * (bouton du panneau de diagnostic), qui le copie dans sa mémoire interne.
 *
 * Aucun appel natif, aucune condition : c'est du texte et un lien.
 */
function ModeleManuelCard() {
  const chemin = useSession((s) => s.modeleManuel);
  if (!chemin) return null;
  return (
    <div className="mx-3 mb-2 shrink-0 rounded-xl border border-border bg-elevated p-3">
      <p className="text-xs font-medium text-fg">Modèle introuvable — import manuel</p>
      <p className="mt-1 text-xs leading-relaxed text-muted text-pretty">
        L&apos;appli essaie de le télécharger elle-même ; si ça échoue,{" "}
        <span className="text-fg">importe-le depuis le téléphone</span> avec le bouton ci-dessous : elle
        le copie dans sa mémoire interne, sous le nom exact ci-dessous. Ne le pose PAS dans le dossier
        partagé (Download) : l&apos;appli n&apos;a aucune permission de stockage et ne peut pas y lire —
        c&apos;est pour ça que le fichier doit passer par l&apos;import.
      </p>
      <div className="mt-2">
        <ImporterModele sansEntete />
      </div>
      <dl className="mt-2 flex flex-col gap-1 text-xs">
        <dt className="text-muted">Nom exact du fichier</dt>
        <dd className="font-mono break-all text-stat">{chemin.fichier}</dd>
        <dt className="text-muted">URL à ouvrir dans Chrome</dt>
        <dd>
          <a
            href={chemin.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono break-all text-hot underline underline-offset-2"
          >
            {chemin.url}
          </a>
        </dd>
        <dt className="text-muted">Emplacement final, dans l&apos;appli</dt>
        <dd className="font-mono break-all text-stat">
          mémoire privée de l&apos;appli / Documents / {chemin.fichier}
        </dd>
      </dl>
    </div>
  );
}

function Header({
  model,
  onModel,
  onClear,
  streaming,
}: {
  model: ModelId;
  onModel: (id: ModelId) => void;
  onClear: () => void;
  streaming: boolean;
}) {
  // L'état RÉEL du moteur : le témoin ci-dessous n'est plus vert par défaut.
  const engine = useSession((s) => s.engine);
  const basculerReglages = useSession((s) => s.basculerReglages);
  return (
    <header className="flex shrink-0 flex-col items-center gap-1 px-3 pt-1 pb-2">
      <div className="flex w-full items-center justify-between">
        <button
          type="button"
          onClick={onClear}
          disabled={streaming}
          className="flex size-10 items-center justify-center rounded-full text-muted disabled:opacity-40"
          aria-label="New chat"
        >
          <RotateCcw className="size-4" strokeWidth={1.75} />
        </button>
        <p className="text-base font-medium tracking-tight">Studio local</p>
        <ModelToggle model={model} onModel={onModel} disabled={streaming} />
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <span className={cn("size-1.5 rounded-full", pointEtat(engine))} />
        {MODELS[model].name} · on-device
        <button
          type="button"
          onClick={() => basculerReglages()}
          className="ml-1 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-muted hover:text-fg"
          aria-label="Réglages du moteur"
        >
          <SlidersHorizontal className="size-3" strokeWidth={2} />
          réglages
        </button>
      </p>
    </header>
  );
}

/**
 * Couleur du témoin d'état du moteur.
 *
 * AVANT : ce point était TOUJOURS vert, même moteur au repos ou en erreur — un
 * voyant « tout va bien » posé à côté de « on-device » alors que rien ne
 * tournait. Il suit maintenant l'état réel renvoyé par le moteur.
 */
function pointEtat(engine: "repos" | "chargement" | "pret" | "erreur") {
  if (engine === "erreur") return "bg-hot";
  if (engine === "pret") return "bg-ok";
  if (engine === "chargement") return "bg-primary";
  return "bg-subtle";
}

function ModelToggle({
  model,
  onModel,
  disabled,
}: {
  model: ModelId;
  onModel: (id: ModelId) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex rounded-full bg-elevated p-0.5">
      {(["coder3b", "coder15", "coder05"] as const).map((id) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          onClick={() => onModel(id)}
          className={cn(
            "min-w-8 rounded-full px-2.5 py-1 text-xs font-medium",
            model === id ? "bg-bubble text-fg" : "text-muted",
          )}
        >
          {MODELS[id].short}
        </button>
      ))}
    </div>
  );
}

function Transcript() {
  const messages = useSession((s) => s.messages);
  const streaming = useSession((s) => s.streaming);
  const send = useSession((s) => s.send);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
      {messages.length === 0 && <EmptyState onPick={send} disabled={streaming} />}
      <ol className="flex flex-col gap-4">
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          const live = streaming && isLast && m.role === "assistant";
          if (m.role === "user") {
            return (
              <li key={m.id} className="flex justify-end">
                <p className="max-w-[86%] rounded-2xl bg-bubble px-3.5 py-2.5 text-sm leading-relaxed text-fg text-pretty">
                  {m.content}
                </p>
              </li>
            );
          }
          return (
            <li key={m.id} className="max-w-[94%] text-sm leading-relaxed text-fg/95 text-pretty">
              <ThinkingBlock thinking={m.thinking} tools={m.tools} live={live} />
              <AssistantBody text={m.content} caret={live && Boolean(m.content)} />
            </li>
          );
        })}
      </ol>
      <div ref={bottom} />
    </div>
  );
}

function AssistantBody({ text, caret }: { text: string; caret: boolean }) {
  if (!text && caret) {
    return (
      <span className="inline-block h-4 w-0.5 animate-[token-caret_1s_steps(1)_infinite] bg-fg" />
    );
  }
  if (!text) return null;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const inner = part.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "");
          return (
            <pre
              key={i}
              className="my-2 overflow-x-auto rounded-lg bg-elevated p-3 font-mono text-xs leading-snug text-stat"
            >
              {inner}
            </pre>
          );
        }
        return (
          <span key={i} className="whitespace-pre-wrap">
            {part}
          </span>
        );
      })}
      {caret && (
        <span className="ml-0.5 inline-block h-4 w-0.5 animate-[token-caret_1s_steps(1)_infinite] bg-fg align-middle" />
      )}
    </>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (t: string) => void; disabled: boolean }) {
  // Chiffres RÉELS du modèle sélectionné (params et poids tirés de `MODELS`).
  // AVANT : « 1,5 Md de paramètres. 1,1 Go en mémoire. » était écrit en dur —
  // faux dès que le modèle par défaut est le 0,5B (0,4 Go), et « 1,1 Go » ne
  // correspondait à aucune valeur connue.
  const model = useSession((s) => s.model);
  const profile = MODELS[model];
  return (
    <div className="flex h-full flex-col justify-end gap-3 pb-2">
      <p className="text-sm text-muted text-pretty">
        {profile.name} — {profile.params} de paramètres, {profile.idleGb.toFixed(2)} Go de poids.
        Tout sur l&apos;appareil.
      </p>
      <ul className="flex flex-col gap-2">
        {SUGGESTIONS.map((s) => (
          <li key={s}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(s)}
              className="w-full rounded-xl border border-border bg-elevated px-3 py-2.5 text-left text-sm text-fg/90"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Composer({
  memoryGb,
  tokPerSec,
  streaming,
  error,
  onSend,
  canRun,
  onRun,
  onCode,
}: {
  memoryGb: number;
  tokPerSec: number;
  streaming: boolean;
  error: string | null;
  onSend: (t: string) => void;
  canRun: boolean;
  onRun: () => void;
  onCode: () => void;
}) {
  const [value, setValue] = useState("");
  const [openTips, setOpenTips] = useState(false);
  const send = useSession((s) => s.send);

  const submit = () => {
    const next = value.trim();
    if (!next || streaming) return;
    setValue("");
    setOpenTips(false);
    onSend(next);
  };

  return (
    <div className="shrink-0 px-3 pt-1 pb-1">
      <div className="mb-2 flex items-center justify-center gap-6 font-android text-xs text-muted tabular-nums">
        {/* Étiqueté « de poids » : c'est la taille RÉELLE du GGUF, pas une
            mesure de la RAM vive de l'appareil (qu'on ne sait pas lire). */}
        <span>{memoryGb.toFixed(2)} GB de poids</span>
        {/*
          Le débit affiché vient du moteur, mais le COMPTE DE JETONS qu'il remonte
          n'est pas fiable tant que le correctif natif de `completionNative`
          (jni.cpp) n'est pas compilé dans le .so : `tokens_predicted` y valait
          toujours `n_predict`. On n'écrit donc plus le mot « mesuré ». Tant
          qu'aucune valeur n'existe, on écrit « — » : « 0.0 tok/s » se lirait
          comme un débit réellement relevé, et c'est exactement l'affichage qui
          trompait alors que le moteur tournait.
        */}
        <span>{tokPerSec > 0 ? `${tokPerSec.toFixed(1)} tok/s` : "— tok/s"}</span>
      </div>
      {error && !/403|inference error|credits|quota/i.test(error) && (
        <p className="mb-2 text-center text-xs text-hot">{error}</p>
      )}
      {canRun && !streaming && (
        <div className="mb-2 flex justify-center gap-2">
          <button
            type="button"
            onClick={onRun}
            className="flex items-center gap-1.5 rounded-full bg-elevated px-3 py-1.5 text-xs font-medium text-fg"
          >
            <Play className="size-3" strokeWidth={2} />
            Run
          </button>
          <button
            type="button"
            onClick={onCode}
            className="flex items-center gap-1.5 rounded-full bg-elevated px-3 py-1.5 text-xs font-medium text-fg"
          >
            <Code2 className="size-3" strokeWidth={2} />
            Code
          </button>
        </div>
      )}
      {openTips && (
        <ul className="mb-2 flex flex-col gap-1">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                className="w-full rounded-lg bg-elevated px-3 py-2 text-left text-xs text-fg/90"
                onClick={() => {
                  setOpenTips(false);
                  send(s);
                }}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2 rounded-full bg-elevated py-1.5 pr-1.5 pl-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button
          type="button"
          onClick={() => setOpenTips((v) => !v)}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-fg"
          aria-label="Prompts"
        >
          <Plus className="size-5" strokeWidth={1.75} />
        </button>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Message"
          disabled={streaming}
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
        />
        <button
          type="submit"
          disabled={streaming || !value.trim()}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-primary-fg disabled:opacity-30"
          aria-label="Send"
        >
          <ArrowUp className="size-4" strokeWidth={2.25} />
        </button>
      </form>
    </div>
  );
}
