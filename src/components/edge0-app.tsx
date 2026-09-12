import { useEffect, useRef, useState } from "react";
import { ArrowUp, Code2, Play, Plus, RotateCcw } from "lucide-react";
import { MODELS, SUGGESTIONS, type ModelId } from "@/lib/edge0";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";
import { AndroidNav, AndroidStatusBar } from "./android-phone";
import { StudioOverlay } from "./studio";
import { ThinkingBlock } from "./thinking";

export function Edge0App({ overlay = false }: { overlay?: boolean }) {
  const {
    model,
    streaming,
    memoryGb,
    tokPerSec,
    error,
    studio,
    studioOpen,
    send,
    clear,
    setModel,
    openStudio,
    setStudioTab,
    tickIdle,
  } = useSession();

  useEffect(() => {
    let frame = 0;
    const loop = (now: number) => {
      tickIdle(now);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [tickIdle]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-screen">
      <AndroidStatusBar />
      <Header model={model} onModel={setModel} onClear={clear} streaming={streaming} />
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
 * de téléchargement le laissait bloqué. Le moteur natif, lui, cherche le GGUF
 * par son nom de fichier dans huit emplacements, dont le dossier Download :
 * télécharger le fichier avec Chrome et le laisser là SUFFIT. Ce panneau donne
 * donc les trois choses nécessaires, sans jargon : le nom EXACT du fichier
 * attendu, l'URL directe à ouvrir, et le dossier où le poser.
 *
 * Aucun appel natif, aucune condition : c'est du texte et un lien.
 */
function ModeleManuelCard() {
  const chemin = useSession((s) => s.modeleManuel);
  if (!chemin) return null;
  return (
    <div className="mx-3 mb-2 shrink-0 rounded-xl border border-border bg-elevated p-3">
      <p className="text-xs font-medium text-fg">Modèle introuvable — mode manuel</p>
      <p className="mt-1 text-xs leading-relaxed text-muted text-pretty">
        Télécharge ce fichier avec Chrome, puis laisse-le dans le dossier{" "}
        <span className="font-mono text-stat">{chemin.dossier}</span> : le moteur le
        trouve tout seul au prochain essai, sans passer par l&apos;appli.
      </p>
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
        <dt className="text-muted">Emplacement attendu</dt>
        <dd className="font-mono break-all text-stat">{chemin.chemin}</dd>
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
        <span className="size-1.5 rounded-full bg-ok" />
        {MODELS[model].name} · on-device
      </p>
    </header>
  );
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

function EmptyState({
  onPick,
  disabled,
}: {
  onPick: (t: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex h-full flex-col justify-end gap-3 pb-2">
      <p className="text-sm text-muted text-pretty">
        1,5 Md de paramètres. 1,1 Go en mémoire. Tout sur l'appareil.
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
        <span>{memoryGb.toFixed(2)} GB</span>
        <span>{tokPerSec.toFixed(1)} tok/s</span>
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
