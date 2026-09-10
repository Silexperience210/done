import { createContext, runInContext } from "node:vm";
import { MODELS, type ModelId } from "@/lib/edge0";

const MAX_HTML = 36_000;
const MAX_JS = 4_000;

function asDocument(title: string, html: string) {
  const safeTitle = title.replace(/[<>]/g, "").slice(0, 80) || "On-device app";
  if (/<html/i.test(html)) return html;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${safeTitle}</title>
<style>
  html,body{margin:0;min-height:100%;background:#09090b;color:#ececef;font:14px/1.45 system-ui,sans-serif}
  canvas,svg{display:block;max-width:100%}
</style>
</head>
<body>
${html}
</body>
</html>`;
}

function sanitizeHtml(html: string) {
  return html
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\s(src|href)\s*=\s*(['"])\s*(https?:|javascript:|data:text\/html)/gi, " data-blocked=$2");
}

export type ToolResult = {
  result: string;
  app?: { title: string; html: string };
};

export function executeTool(
  name: string,
  rawArgs: string,
  ctx: { model: ModelId; memoryGb: number; tokPerSec: number },
): ToolResult {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { result: JSON.stringify({ error: "Invalid arguments" }) };
  }

  if (name === "write_app") {
    const title = typeof args.title === "string" ? args.title.slice(0, 80) : "App";
    const html = typeof args.html === "string" ? args.html : "";
    if (html.length < 20) return { result: JSON.stringify({ error: "html too short" }) };
    if (html.length > MAX_HTML) return { result: JSON.stringify({ error: "html too large" }) };
    const doc = asDocument(title, sanitizeHtml(html));
    return {
      result: JSON.stringify({ ok: true, title, bytes: doc.length }),
      app: { title, html: doc },
    };
  }

  if (name === "run_js") {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) return { result: JSON.stringify({ error: "empty code" }) };
    if (code.length > MAX_JS) return { result: JSON.stringify({ error: "code too long" }) };
    return { result: JSON.stringify(runJs(code)) };
  }

  if (name === "device_telemetry") {
    const m = MODELS[ctx.model];
    return {
      result: JSON.stringify({
        model: m.name,
        working_set_gb: Number(ctx.memoryGb.toFixed(2)),
        peak_gb: m.peakGb,
        tok_s: Number(ctx.tokPerSec.toFixed(1)),
        experts_in_ram: m.topK,
        experts_on_ufs: m.experts - m.topK,
        layers: m.layers,
      }),
    };
  }

  return { result: JSON.stringify({ error: `unknown tool ${name}` }) };
}

function runJs(code: string) {
  const logs: string[] = [];
  const sandbox = createContext({
    Math,
    JSON,
    Number,
    String,
    Array,
    Object,
    Boolean,
    Date,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    console: {
      log: (...parts: unknown[]) => {
        logs.push(parts.map((p) => stringify(p)).join(" "));
      },
    },
  });
  try {
    const value = runInContext(code, sandbox, { timeout: 250, displayErrors: true });
    return {
      ok: true,
      logs: logs.slice(0, 40),
      result: value === undefined ? null : stringify(value).slice(0, 2000),
    };
  } catch (err) {
    return { ok: false, logs, error: String(err).slice(0, 400) };
  }
}

function stringify(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
