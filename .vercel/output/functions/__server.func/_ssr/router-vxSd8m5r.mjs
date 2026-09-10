import { i as __toESM } from "../_runtime.mjs";
import { L as require_react, _ as useRouter, f as createRouter, g as createRootRoute, h as createFileRoute, l as Scripts, m as lazyRouteComponent, p as Outlet, u as HeadContent, v as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { r as TriangleAlert } from "../_libs/lucide-react.mjs";
import { a as union, i as string, n as number, r as object, t as literal } from "../_libs/zod.mjs";
import { createContext, runInContext } from "node:vm";
//#region node_modules/.nitro/vite/services/ssr/assets/router-vxSd8m5r.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var FALLBACK_MESSAGE = "An unexpected error occurred. Try reloading the page.";
function errorMessage(error) {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return FALLBACK_MESSAGE;
}
function AppErrorComponent({ error }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "text-red-500",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TriangleAlert, {
					className: "size-10",
					strokeWidth: 2
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "text-lg font-semibold",
				children: "Something went wrong"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "max-w-md text-sm break-words text-zinc-500 dark:text-zinc-400",
				children: errorMessage(error)
			})
		]
	});
}
/**
* App-wide client provider mounted once near the root (in `src/routes/__root.tsx`):
*
*   <AuthProvider><Outlet /></AuthProvider>
*
* Better Auth's React client (`@/lib/auth/client`) needs NO context provider —
* its `useSession()` works standalone — so this is a passthrough today. It's
* kept as the single, stable mount point for any future client-side providers
* (e.g. a toast or theme provider) without churning the root shell.
*/
function AuthProvider({ children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children });
}
var CONNECTOR_TOKEN_READY_EVENT = "grok:connector-token-ready";
function isGrokEmbedderOrigin(origin) {
	try {
		const url = new URL(origin);
		if (url.protocol !== "https:" && url.protocol !== "http:") return false;
		const host = url.hostname.toLowerCase();
		if (host === "grok.com" || host.endsWith(".grok.com")) return true;
		if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
		return false;
	} catch {
		return false;
	}
}
function isSandboxPreviewGuestHost(hostname) {
	const host = hostname.toLowerCase();
	return host === "grok-sandbox.com" || host.endsWith(".grok-sandbox.com");
}
function isRemintPreviewPair(guestHost, parentHost) {
	const guest = guestHost.toLowerCase();
	const parent = parentHost.toLowerCase();
	const i = guest.indexOf(".preview.");
	if (i <= 0) return false;
	const label = guest.slice(0, i);
	const rest = guest.slice(i + 9);
	if (label.includes(".") || !rest.includes(".")) return false;
	return parent === rest || parent === `grok.${rest}`;
}
function resolveParentEmbedderOrigin(parentIsSelf, referrer, ancestorOrigin, guestHostname = "") {
	if (parentIsSelf) return null;
	for (const candidate of [referrer, ancestorOrigin ?? ""].filter(Boolean)) try {
		const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
		if (url.protocol !== "https:" && url.protocol !== "http:") continue;
		if (isGrokEmbedderOrigin(url.origin)) return url.origin;
		if (isSandboxPreviewGuestHost(guestHostname) || isRemintPreviewPair(guestHostname, url.hostname)) return url.origin;
	} catch {}
	return null;
}
/**
* Guest side of the grok-web ↔ sandbox preview postMessage bridge.
*
* Activates only when this page is framed by an allowlisted Grok embedder.
* Top-level runs (download/export, local `npm run dev`, deployed sites) noop.
*/
var PREVIEW_BRIDGE_CHANNEL = "grok-preview-bridge";
var EnvelopeSchema = object({
	channel: literal(PREVIEW_BRIDGE_CHANNEL),
	version: number().int().positive(),
	type: string().min(1)
});
var HelloSchema = EnvelopeSchema.extend({ type: literal("hello") });
var NavigateSchema = EnvelopeSchema.extend({
	type: literal("navigate"),
	path: string().min(1)
});
var HistorySchema = EnvelopeSchema.extend({
	type: literal("history"),
	delta: union([literal(-1), literal(1)])
});
var ConnectorTokenReadySchema = EnvelopeSchema.extend({ type: literal("connector-token-ready") });
function isSafeBridgePath(path) {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
	try {
		return new URL(path, "https://preview.invalid").origin === "https://preview.invalid";
	} catch {
		return false;
	}
}
/**
* Origin of the Grok embedder framing this page, or null when the page runs
* top-level (download/export, local `npm run dev`, deployed sites) or under a
* non-Grok parent. Client-only; null during SSR.
*/
function resolveCurrentEmbedderOrigin() {
	if (typeof window === "undefined") return null;
	const ancestorOrigin = typeof location.ancestorOrigins !== "undefined" && location.ancestorOrigins.length > 0 ? location.ancestorOrigins[0] : null;
	return resolveParentEmbedderOrigin(window.parent === window, document.referrer, ancestorOrigin, window.location.hostname);
}
/**
* Install host↔guest messaging. Returns a dispose function.
* Noops (returns a no-op dispose) when not embedded under a Grok parent.
*/
function installPreviewHostBridge(options = {}) {
	const parentOrigin = resolveCurrentEmbedderOrigin();
	if (parentOrigin === null) return () => {};
	const ROOT_STATE_KEY = "__grokPreviewBridgeRoot";
	const originalPushState = window.history.pushState.bind(window.history);
	const originalReplaceState = window.history.replaceState.bind(window.history);
	const isAtHistoryRoot = () => {
		const state = window.history.state;
		return Boolean(state && typeof state === "object" && state[ROOT_STATE_KEY] === true);
	};
	try {
		const current = window.history.state;
		if (!(current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, ROOT_STATE_KEY))) {
			const isRoot = window.history.length <= 1;
			originalReplaceState(current && typeof current === "object" ? {
				...current,
				[ROOT_STATE_KEY]: isRoot
			} : { [ROOT_STATE_KEY]: isRoot }, "", window.location.href);
		}
	} catch {}
	const post = (message) => {
		window.parent.postMessage(message, parentOrigin);
	};
	const reportLocation = () => {
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "location",
			path: window.location.pathname || "/",
			search: window.location.search,
			hash: window.location.hash
		});
	};
	const reportRoutes = () => {
		const paths = options.getRoutePaths?.() ?? [];
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "routes",
			paths
		});
	};
	const defaultNavigate = (path) => {
		if (!isSafeBridgePath(path)) return;
		try {
			const url = new URL(path, window.location.origin);
			if (url.origin !== window.location.origin) return;
			const next = `${url.pathname}${url.search}${url.hash}`;
			window.history.pushState(window.history.state, "", next);
			window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
		} catch {}
	};
	const navigate = (path) => {
		if (!isSafeBridgePath(path)) return;
		if (options.navigate) {
			options.navigate(path);
			return;
		}
		defaultNavigate(path);
	};
	const announce = () => {
		reportLocation();
		reportRoutes();
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "ready"
		});
	};
	const onHello = (data) => {
		if (!HelloSchema.safeParse(data).success) return;
		announce();
	};
	const onNavigate = (data) => {
		const parsed = NavigateSchema.safeParse(data);
		if (!parsed.success) return;
		navigate(parsed.data.path);
		queueMicrotask(reportLocation);
	};
	const onHistory = (data) => {
		const parsed = HistorySchema.safeParse(data);
		if (!parsed.success) return;
		if (parsed.data.delta === -1 && isAtHistoryRoot()) return;
		window.history.go(parsed.data.delta);
	};
	const onConnectorTokenReady = (data) => {
		if (!ConnectorTokenReadySchema.safeParse(data).success) return;
		window.dispatchEvent(new Event(CONNECTOR_TOKEN_READY_EVENT));
	};
	const hostMessageHandlers = /* @__PURE__ */ new Map([
		["hello", onHello],
		["navigate", onNavigate],
		["history", onHistory],
		["connector-token-ready", onConnectorTokenReady]
	]);
	const onMessage = (event) => {
		if (event.source !== window.parent) return;
		if (event.origin !== parentOrigin) return;
		const envelope = EnvelopeSchema.safeParse(event.data);
		if (!envelope.success || envelope.data.version !== 1) return;
		hostMessageHandlers.get(envelope.data.type)?.(event.data);
	};
	const onPopState = () => {
		reportLocation();
	};
	const onHashChange = () => {
		reportLocation();
	};
	window.history.pushState = (data, unused, url) => {
		const next = data && typeof data === "object" ? {
			...data,
			[ROOT_STATE_KEY]: false
		} : data;
		originalPushState(next, unused, url);
		reportLocation();
	};
	window.history.replaceState = (data, unused, url) => {
		const next = isAtHistoryRoot() ? {
			...data && typeof data === "object" ? data : {},
			[ROOT_STATE_KEY]: true
		} : data;
		originalReplaceState(next, unused, url);
		reportLocation();
	};
	window.addEventListener("message", onMessage);
	window.addEventListener("popstate", onPopState);
	window.addEventListener("hashchange", onHashChange);
	announce();
	return () => {
		window.removeEventListener("message", onMessage);
		window.removeEventListener("popstate", onPopState);
		window.removeEventListener("hashchange", onHashChange);
		window.history.pushState = originalPushState;
		window.history.replaceState = originalReplaceState;
	};
}
/** Collect static path patterns from a TanStack route tree (best-effort). */
function collectRoutePathsFromTree(routeTree) {
	const paths = /* @__PURE__ */ new Set();
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		const record = node;
		const full = typeof record.fullPath === "string" ? record.fullPath : typeof record.path === "string" ? record.path : null;
		if (full !== null && full !== "") paths.add(full.startsWith("/") ? full : `/${full}`);
		else if (full === "") paths.add("/");
		const children = record.children;
		if (Array.isArray(children)) for (const child of children) walk(child);
		else if (children && typeof children === "object") for (const child of Object.values(children)) walk(child);
	};
	walk(routeTree);
	return [...paths];
}
/**
* Mount once in `__root.tsx` so the Grok preview chrome can drive navigation
* (and later receive registered routes). Noops when the app is not embedded.
*/
function PreviewHostBridge() {
	const router = useRouter();
	(0, import_react.useEffect)(() => {
		return installPreviewHostBridge({
			navigate: (path) => {
				router.history.push(path);
			},
			getRoutePaths: () => collectRoutePathsFromTree(router.routeTree)
		});
	}, [router]);
	return null;
}
var styles_default = "/assets/styles-DHWmL_bT.css";
var APP_NAME = "Edge0 Android";
var Route$2 = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1, viewport-fit=cover"
			},
			{ title: APP_NAME },
			{
				name: "description",
				content: "A 35B language model running on Android using only 1–2.5 GB of peak memory. No cloud. No remote server."
			},
			{
				name: "theme-color",
				content: "#070708"
			}
		],
		links: [
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/favicon.svg"
			},
			{
				rel: "stylesheet",
				href: styles_default
			},
			{
				rel: "manifest",
				href: "/__grok/manifest.webmanifest"
			},
			{
				rel: "apple-touch-icon",
				href: "/__grok/icon-180.png"
			},
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com"
			},
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous"
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Roboto:wght@400;500;600&display=swap"
			}
		]
	}),
	component: () => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("html", {
		lang: "en",
		suppressHydrationWarning: true,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("head", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HeadContent, {}) }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("body", {
			className: "antialiased",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PreviewHostBridge, {}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AuthProvider, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {}) }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Scripts, {})
			]
		})]
	})
});
var $$splitComponentImporter = () => import("./routes-DH_eJSwX.mjs");
var Route$1 = createFileRoute("/")({ component: lazyRouteComponent($$splitComponentImporter, "component") });
var MODELS = {
	"35b": {
		id: "35b",
		name: "Edge0-35B",
		short: "35B",
		subtitle: "A3B · 256 experts · K=4",
		params: "35B",
		diskGb: 23,
		idleGb: 1.84,
		peakGb: 3.98,
		tokMin: 14.9,
		tokMax: 17.7,
		experts: 256,
		topK: 4,
		layers: 40,
		activeGb: "up to 4 GB"
	},
	"8b": {
		id: "8b",
		name: "Edge0-8B",
		short: "8B",
		subtitle: "A1B · 128 experts · K=8",
		params: "8B",
		diskGb: 4.2,
		idleGb: 1.12,
		peakGb: 2.36,
		tokMin: 23.9,
		tokMax: 25.3,
		experts: 128,
		topK: 8,
		layers: 24,
		activeGb: "1–2.4 GB"
	}
};
var SEED_PROMPT = "Explain streaming inference in one sentence.";
var SEED_REPLY = "Streaming inference is the process of generating tokens (words or parts of words) one by one in real-time, as they are computed, rather than waiting for the entire sequence to be generated before outputting anything.";
var SUGGESTIONS = [
	"Un mini-jeu ping-pong que je peux lancer ici.",
	"Écris un mini-jeu snake que je peux lancer ici.",
	"Un canvas de particules que je peux essayer.",
	"Calcule 17 puissance 6 avec un outil."
];
var TOOL_DEFS = [
	{
		type: "function",
		function: {
			name: "write_app",
			description: "Write a complete dark HTML app into the studio (game, canvas, widget). No external URLs.",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string" },
					html: {
						type: "string",
						description: "Full HTML or body fragment. #09090b, vanilla JS/CSS/canvas, <160 lines."
					}
				},
				required: ["title", "html"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "run_js",
			description: "Run a short JS snippet in a sandbox. Use for calculations.",
			parameters: {
				type: "object",
				properties: { code: { type: "string" } },
				required: ["code"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "device_telemetry",
			description: "Read current RAM, tok/s, experts in RAM.",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	}
];
function wantsTools(text) {
	return /game|html|playable|scene|page|\bapp\b|interactive|canvas|widget|snake|particule|particle|jeu|code|calcul|puissance|compute|\boutil\b|tool|telemetry|working set|\bram\b|expert|snake|demo|démo/i.test(text);
}
function isFrench(text) {
	return /[éèêëàâùûçîïœ]/i.test(text) || /\b(le|la|les|un|une|des|écris|calcule|comment|avec|pour|que|je)\b/i.test(text);
}
function newId() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function extractHtmlBlock(text) {
	const fence = text.match(/```(?:html|HTML)\s*([\s\S]*?)```/);
	if (fence?.[1]) {
		const body = fence[1].trim();
		if (body.length > 40) return body;
	}
	const doc = text.match(/<!DOCTYPE html[\s\S]*<\/html>/i);
	return doc ? doc[0] : null;
}
function toolLabel(name) {
	if (name === "write_app") return "write_app";
	if (name === "run_js") return "run_js";
	if (name === "device_telemetry") return "telemetry";
	return name;
}
function systemPrompt(model) {
	const m = MODELS[model];
	return [
		`You are ${m.name}, a ${m.params} sparse MoE model on an Android phone. Peak RAM ${m.activeGb}. Offline, local — never mention Grok, xAI, cloud, or remote APIs.`,
		"Be brief. Match the user's language.",
		"Games/canvas/widgets: call write_app, do not dump HTML in chat.",
		"Math/algorithms: call run_js.",
		"HTML: #09090b, no network, vanilla JS/CSS, under 120 lines."
	].join(" ");
}
function matchLocalApp(text) {
	const t = text.toLowerCase();
	const fr = isFrench(text);
	if (/pong|ping[\s-]?pong|pingpong|tree\.js|three\.?js/.test(t)) return pingPong(fr);
	if (/snake/.test(t)) return snake(fr);
	if (/particule|particle/.test(t)) return particles(fr);
	if (/jeu|game|playable|canvas|widget|mini[\s-]?jeu|html/.test(t)) return pingPong(fr);
	return null;
}
function fallbackApp(text) {
	return pingPong(isFrench(text));
}
function localChat(text) {
	const fr = isFrench(text);
	const t = text.toLowerCase();
	if (/stream/.test(t)) return fr ? "L’inférence streamée émet les tokens un par un, dès qu’ils sont calculés, au lieu d’attendre la séquence entière." : "Streaming inference emits tokens one by one as they are computed, instead of waiting for the full sequence.";
	if (/ram|mémoire|memory|4\s*go|4\s*gb|working set/.test(t)) return fr ? "Le checkpoint 35B reste sur UFS (~23 Go). Seuls les experts actifs (K=4) montent en RAM — pic autour de 4 Go." : "The 35B checkpoint stays on UFS (~23 GB). Only active experts (K=4) enter RAM — peak around 4 GB.";
	return fr ? "Je tourne en local. Demande ping-pong, snake, des particules ou un calcul — je l’exécute ici, sans code à écrire." : "I run on-device. Ask for ping pong, snake, particles, or a calculation — I’ll run it here, no coding.";
}
function resolveLocalTurn(text, force = false) {
	const app = matchLocalApp(text);
	if (app) return {
		kind: "app",
		app
	};
	const calc = matchLocalCalc(text);
	if (calc) return {
		kind: "calc",
		expression: calc.expression,
		value: calc.value,
		note: isFrench(text) ? `Résultat : ${calc.value}` : `Result: ${calc.value}`
	};
	if (force && /jeu|game|html|canvas|code|widget|app|playable/.test(text.toLowerCase())) return {
		kind: "app",
		app: fallbackApp(text)
	};
	return {
		kind: "chat",
		content: localChat(text)
	};
}
function matchLocalCalc(text) {
	const pow = text.match(/(\d+(?:\.\d+)?)\s*(?:\^|puissance|\*\*)\s*(\d{1,4})/i);
	if (pow) {
		const a = Number(pow[1]);
		const b = Number(pow[2]);
		if (b > 12) return null;
		const value = String(a ** b);
		return {
			expression: `${pow[1]}^${pow[2]}`,
			value
		};
	}
	const simple = text.match(/calcule\s+([\d\s+\-*/().]+)/i);
	if (simple) {
		const expr = simple[1].replace(/\s+/g, "");
		if (!/^[\d+\-*/().]+$/.test(expr)) return null;
		try {
			const value = Function(`"use strict"; return (${expr})`)();
			if (typeof value !== "number" || !Number.isFinite(value)) return null;
			return {
				expression: expr,
				value: String(value)
			};
		} catch {
			return null;
		}
	}
	return null;
}
function pingPong(fr) {
	return {
		title: "Ping Pong",
		tool: "write_app",
		note: fr ? "Ping-pong prêt. Touche l’écran pour jouer — pas besoin de code." : "Ping pong is ready. Tap the screen to play — no coding.",
		html: PONG_HTML
	};
}
function snake(fr) {
	return {
		title: "Snake",
		tool: "write_app",
		note: fr ? "Snake est dans le studio. Swipe pour jouer." : "Snake is in the studio. Swipe to play.",
		html: SNAKE_HTML
	};
}
function particles(fr) {
	return {
		title: "Particles",
		tool: "write_app",
		note: fr ? "Canvas de particules lancé. Bouge le doigt." : "Particle canvas is running. Drag to stir.",
		html: PARTICLES_HTML
	};
}
var PONG_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
<title>Ping Pong</title>
<style>
  html,body{margin:0;height:100%;background:#09090b;color:#ececef;font:14px/1.4 system-ui,sans-serif;overflow:hidden;touch-action:none}
  canvas{display:block;width:100%;height:100%}
  #hud{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:18px 16px 28px;pointer-events:none}
  #score{font:600 18px ui-monospace,monospace;letter-spacing:.12em}
  #hint{margin-top:8px;font-size:12px;color:#9a9aa3}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="hud"><div id="score">0 : 0</div><div id="hint">Tap to serve · drag to move</div></div>
<script>
const canvas=document.getElementById("c");
const ctx=canvas.getContext("2d");
const scoreEl=document.getElementById("score");
const hintEl=document.getElementById("hint");
let W=0,H=0,dpr=1;
const state={
  running:false,
  px:0.5, ai:0.5,
  bx:0.5, by:0.72, vx:0.22, vy:-0.42,
  you:0, cpu:0, pw:0.22, aw:0.2
};
function resize(){
  dpr=Math.min(2, window.devicePixelRatio||1);
  W=canvas.clientWidth; H=canvas.clientHeight;
  canvas.width=W*dpr; canvas.height=H*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
function reset(serve){
  state.bx=0.5; state.by=0.62;
  const dir=serve|| (Math.random()<0.5?1:-1);
  state.vx=(Math.random()*0.28+0.16)* (Math.random()<0.5?-1:1);
  state.vy=-0.46*dir;
}
function pointer(e){
  const r=canvas.getBoundingClientRect();
  const x=(e.clientX-r.left)/r.width;
  state.px=Math.max(0.08, Math.min(0.92, x));
  if(!state.running){ state.running=true; hintEl.textContent="First to 7"; }
}
canvas.addEventListener("pointerdown", pointer);
canvas.addEventListener("pointermove", pointer);
window.addEventListener("resize", resize);
resize();
reset(1);
let last=performance.now();
function frame(now){
  const dt=Math.min(0.032,(now-last)/1000); last=now;
  const tableTop=H*0.12, tableBot=H*0.92;
  const nearY=tableBot, farY=tableTop;
  function scaleAt(y){ return 0.42 + 0.58*((y-farY)/(nearY-farY)); }
  if(state.running){
    state.bx+=state.vx*dt;
    state.by+=state.vy*dt;
    const target=state.bx + state.vx*0.18;
    state.ai+=(target-state.ai)*Math.min(1, dt*4.2);
    state.ai=Math.max(0.1, Math.min(0.9, state.ai));
    if(state.bx<0.04){ state.bx=0.04; state.vx=Math.abs(state.vx); }
    if(state.bx>0.96){ state.bx=0.96; state.vx=-Math.abs(state.vx); }
    const ballY=farY+(nearY-farY)*state.by;
    const pY=nearY-18, aY=farY+22;
    const pL=state.px-state.pw/2, pR=state.px+state.pw/2;
    const aL=state.ai-state.aw/2, aR=state.ai+state.aw/2;
    if(state.vy>0 && state.by>0.86 && state.by<0.98 && state.bx>pL && state.bx<pR){
      state.by=0.86; state.vy=-Math.abs(state.vy)*1.03;
      state.vx+=(state.bx-state.px)*1.8;
    }
    if(state.vy<0 && state.by<0.16 && state.by>0.04 && state.bx>aL && state.bx<aR){
      state.by=0.16; state.vy=Math.abs(state.vy)*1.03;
      state.vx+=(state.bx-state.ai)*1.5;
    }
    if(state.by>1.08){ state.cpu++; state.running=false; reset(-1); hintEl.textContent="CPU scores · tap"; }
    if(state.by<-0.06){ state.you++; state.running=false; reset(1); hintEl.textContent="You score · tap"; }
    if(state.you>=7 || state.cpu>=7){
      hintEl.textContent=(state.you>=7?"You win":"CPU wins")+" · tap to restart";
      if(!state.running){ state.you=0; state.cpu=0; }
    }
    scoreEl.textContent=state.you+" : "+state.cpu;
  }
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle="#09090b"; ctx.fillRect(0,0,W,H);
  const leftN=W*0.08, rightN=W*0.92, leftF=W*0.24, rightF=W*0.76;
  ctx.beginPath();
  ctx.moveTo(leftN,nearY); ctx.lineTo(rightN,nearY); ctx.lineTo(rightF,farY); ctx.lineTo(leftF,farY);
  ctx.closePath();
  ctx.fillStyle="#121214"; ctx.fill();
  ctx.strokeStyle="#2a2a30"; ctx.lineWidth=2; ctx.stroke();
  ctx.setLineDash([6,8]); ctx.beginPath();
  ctx.moveTo(W/2,nearY); ctx.lineTo(W/2,farY); ctx.strokeStyle="#3f3f46"; ctx.stroke(); ctx.setLineDash([]);
  function paddle(cx,y,w,h,color){
    const s=scaleAt(y); const pw=w*W*s, ph=h*s;
    ctx.fillStyle=color;
    ctx.fillRect(cx*W-pw/2, y-ph, pw, ph);
  }
  paddle(state.px, nearY-6, state.pw, 14, "#ececef");
  paddle(state.ai, farY+18, state.aw, 10, "#a1a1aa");
  const by=farY+(nearY-farY)*Math.max(0,Math.min(1,state.by));
  const s=scaleAt(by); const r=9*s;
  ctx.beginPath(); ctx.ellipse(state.bx*W, by+10*s, r*1.1, r*0.35, 0, 0, Math.PI*2);
  ctx.fillStyle="rgba(0,0,0,.35)"; ctx.fill();
  ctx.beginPath(); ctx.arc(state.bx*W, by, r, 0, Math.PI*2);
  ctx.fillStyle="#f4f4f5"; ctx.fill();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
<\/script>
</body>
</html>`;
var SNAKE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
<style>html,body{margin:0;height:100%;background:#09090b;color:#ececef;font:13px system-ui;overflow:hidden;touch-action:none}canvas{display:block;width:100%;height:100%}#s{position:fixed;top:12px;left:0;right:0;text-align:center;font:600 14px ui-monospace,monospace}</style>
</head><body><div id="s">0</div><canvas id="c"></canvas>
<script>
const c=document.getElementById("c"),x=c.getContext("2d"),sEl=document.getElementById("s");
let dpr=1,W,H,cell=18,cols,rows,snake,dir,next,food,score=0,dead=false;
function fit(){dpr=Math.min(2,devicePixelRatio||1);W=c.clientWidth;H=c.clientHeight;c.width=W*dpr;c.height=H*dpr;x.setTransform(dpr,0,0,dpr,0,0);cols=Math.floor(W/cell);rows=Math.floor(H/cell);}
function reset(){snake=[{x:4,y:6},{x:3,y:6},{x:2,y:6}];dir={x:1,y:0};next=dir;place();score=0;dead=false;sEl.textContent="0";}
function place(){food={x:1+Math.floor(Math.random()*(cols-2)),y:1+Math.floor(Math.random()*(rows-2))};}
fit();reset();
addEventListener("resize",()=>{fit();});
let sx,sy;
c.addEventListener("pointerdown",e=>{sx=e.clientX;sy=e.clientY;if(dead)reset();});
c.addEventListener("pointerup",e=>{const dx=e.clientX-sx,dy=e.clientY-sy;if(Math.abs(dx)<8&&Math.abs(dy)<8)return;
if(Math.abs(dx)>Math.abs(dy)) next={x:dx>0?1:-1,y:0}; else next={x:0,y:dy>0?1:-1};
if(next.x===-dir.x&&next.y===-dir.y) next=dir;});
setInterval(()=>{
  if(dead)return;
  dir=next;const h={x:snake[0].x+dir.x,y:snake[0].y+dir.y};
  if(h.x<0||h.y<0||h.x>=cols||h.y>=rows||snake.some(p=>p.x===h.x&&p.y===h.y)){dead=true;sEl.textContent=score+" · tap";return;}
  snake.unshift(h);
  if(h.x===food.x&&h.y===food.y){score+=1;sEl.textContent=String(score);place();} else snake.pop();
  x.fillStyle="#09090b";x.fillRect(0,0,W,H);
  x.fillStyle="#3f3f46";x.fillRect(food.x*cell+2,food.y*cell+2,cell-4,cell-4);
  snake.forEach((p,i)=>{x.fillStyle=i===0?"#ececef":"#a1a1aa";x.fillRect(p.x*cell+1,p.y*cell+1,cell-2,cell-2);});
},110);
<\/script></body></html>`;
var PARTICLES_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>html,body{margin:0;height:100%;background:#09090b;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>
</head><body><canvas id="c"></canvas>
<script>
const c=document.getElementById("c"),x=c.getContext("2d");
let W,H,dpr=1,pts=[],mx=.5,my=.5;
function fit(){dpr=Math.min(2,devicePixelRatio||1);W=c.clientWidth;H=c.clientHeight;c.width=W*dpr;c.height=H*dpr;x.setTransform(dpr,0,0,dpr,0,0);
if(!pts.length){for(let i=0;i<90;i++)pts.push({x:Math.random()*W,y:Math.random()*H,vx:0,vy:0});}}
fit();addEventListener("resize",fit);
c.addEventListener("pointermove",e=>{const r=c.getBoundingClientRect();mx=e.clientX-r.left;my=e.clientY-r.top;});
function loop(){
  x.fillStyle="rgba(9,9,11,.22)";x.fillRect(0,0,W,H);
  for(const p of pts){
    const dx=mx-p.x,dy=my-p.y,d=Math.hypot(dx,dy)+40;
    p.vx+=dx/d*0.35; p.vy+=dy/d*0.35; p.vx*=.96; p.vy*=.96;
    p.x+=p.vx; p.y+=p.vy;
    if(p.x<0||p.x>W)p.vx*=-1; if(p.y<0||p.y>H)p.vy*=-1;
    x.beginPath();x.arc(p.x,p.y,2.2,0,Math.PI*2);x.fillStyle="#d4d4d8";x.fill();
  }
  requestAnimationFrame(loop);
}
loop();
<\/script></body></html>`;
var MAX_HTML = 36e3;
var MAX_JS = 4e3;
function asDocument(title, html) {
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
function sanitizeHtml(html) {
	return html.replace(/<iframe[\s\S]*?<\/iframe>/gi, "").replace(/\s(src|href)\s*=\s*(['"])\s*(https?:|javascript:|data:text\/html)/gi, " data-blocked=$2");
}
function executeTool(name, rawArgs, ctx) {
	let args = {};
	try {
		args = rawArgs ? JSON.parse(rawArgs) : {};
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
			result: JSON.stringify({
				ok: true,
				title,
				bytes: doc.length
			}),
			app: {
				title,
				html: doc
			}
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
		return { result: JSON.stringify({
			model: m.name,
			working_set_gb: Number(ctx.memoryGb.toFixed(2)),
			peak_gb: m.peakGb,
			tok_s: Number(ctx.tokPerSec.toFixed(1)),
			experts_in_ram: m.topK,
			experts_on_ufs: m.experts - m.topK,
			layers: m.layers
		}) };
	}
	return { result: JSON.stringify({ error: `unknown tool ${name}` }) };
}
function runJs(code) {
	const logs = [];
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
		console: { log: (...parts) => {
			logs.push(parts.map((p) => stringify(p)).join(" "));
		} }
	});
	try {
		const value = runInContext(code, sandbox, {
			timeout: 250,
			displayErrors: true
		});
		return {
			ok: true,
			logs: logs.slice(0, 40),
			result: value === void 0 ? null : stringify(value).slice(0, 2e3)
		};
	} catch (err) {
		return {
			ok: false,
			logs,
			error: String(err).slice(0, 400)
		};
	}
}
function stringify(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
var MAX_CHARS = 1800;
var MAX_TURNS = 2;
var FAST_MODELS = [
	"grok-4-fast-non-reasoning",
	"grok-4.1-fast",
	"grok-4.5"
];
var cachedUpstream = null;
var Route = createFileRoute("/api/chat")({ server: { handlers: { POST: async ({ request }) => {
	const apiKey = process.env.XAI_API_KEY;
	if (!apiKey) return Response.json({ error: "AI is not available" }, { status: 503 });
	let parsed;
	try {
		parsed = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	const modelId = parsed.model === "8b" ? "8b" : "35b";
	const history = (Array.isArray(parsed.messages) ? parsed.messages : []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0).slice(-8).map((m) => ({
		role: m.role,
		content: m.content.slice(0, MAX_CHARS)
	}));
	if (history.length === 0) return Response.json({ error: "No messages" }, { status: 400 });
	const encoder = new TextEncoder();
	const stream = new ReadableStream({ async start(controller) {
		const send = (obj) => {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
		};
		try {
			await runAgent({
				apiKey,
				modelId,
				history,
				send
			});
			send({ type: "done" });
		} catch {
			emitLocalTurn(resolveLocalTurn([...history].reverse().find((m) => m.role === "user")?.content ?? "", true), send);
			send({ type: "done" });
		} finally {
			controller.close();
		}
	} });
	return new Response(stream, { headers: {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		"X-Accel-Buffering": "no",
		Connection: "keep-alive"
	} });
} } } });
async function runAgent({ apiKey, modelId, history, send }) {
	const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
	const local = resolveLocalTurn(lastUser);
	if (local.kind !== "chat") {
		emitLocalTurn(local, send);
		return;
	}
	const useTools = wantsTools(lastUser);
	const tools = useTools ? pickTools(lastUser) : void 0;
	const french = isFrench(lastUser);
	const messages = [{
		role: "system",
		content: systemPrompt(modelId)
	}, ...history];
	const profile = MODELS[modelId];
	const maxTokens = useTools ? modelId === "8b" ? 520 : 700 : modelId === "8b" ? 220 : 320;
	try {
		for (let turn = 0; turn < MAX_TURNS; turn++) {
			const result = await completeTurn({
				apiKey,
				messages,
				send,
				tools: turn === 0 ? tools : void 0,
				maxTokens: turn === 0 ? maxTokens : 160
			});
			if (result.toolCalls.length === 0) {
				if (!result.streamedContent && result.content) send({
					type: "token",
					text: result.content
				});
				return;
			}
			messages.push({
				role: "assistant",
				content: result.content || null,
				tool_calls: result.toolCalls
			});
			let wroteApp = false;
			let jsSummary = null;
			await Promise.all(result.toolCalls.map(async (call) => {
				send({
					type: "tool",
					id: call.id,
					name: call.function.name,
					status: "start",
					args: safeParse(call.function.arguments)
				});
				const executed = executeTool(call.function.name, call.function.arguments, {
					model: modelId,
					memoryGb: profile.peakGb * .82,
					tokPerSec: profile.tokMin
				});
				if (executed.app) {
					wroteApp = true;
					send({
						type: "app",
						...executed.app
					});
				}
				if (call.function.name === "run_js") jsSummary = formatJs(executed.result, french);
				send({
					type: "tool",
					id: call.id,
					name: call.function.name,
					status: "done",
					result: executed.result.slice(0, 1500)
				});
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: executed.result
				});
			}));
			if (result.streamedContent) return;
			if (wroteApp) {
				send({
					type: "token",
					text: french ? "C’est dans le studio. Run pour lancer, Code pour lire." : "It’s in the studio. Run to play, Code to read."
				});
				return;
			}
			if (jsSummary) {
				send({
					type: "token",
					text: jsSummary
				});
				return;
			}
		}
	} catch {
		emitLocalTurn(resolveLocalTurn(lastUser, true), send);
	}
}
function emitLocalTurn(turn, send) {
	if (turn.kind === "app") {
		const app = turn.app;
		send({
			type: "thinking",
			text: "Prerouter → write_app · studio\n"
		});
		send({
			type: "tool",
			id: "local-app",
			name: "write_app",
			status: "start",
			args: { title: app.title }
		});
		send({
			type: "app",
			title: app.title,
			html: app.html
		});
		send({
			type: "tool",
			id: "local-app",
			name: "write_app",
			status: "done",
			result: app.title
		});
		send({
			type: "token",
			text: app.note
		});
		return;
	}
	if (turn.kind === "calc") {
		send({
			type: "thinking",
			text: "Prerouter → run_js · sandbox\n"
		});
		send({
			type: "tool",
			id: "local-js",
			name: "run_js",
			status: "start",
			args: { code: turn.expression }
		});
		send({
			type: "tool",
			id: "local-js",
			name: "run_js",
			status: "done",
			result: turn.value
		});
		send({
			type: "token",
			text: turn.note
		});
		return;
	}
	send({
		type: "token",
		text: turn.content
	});
}
function pickTools(text) {
	const calc = /calcul|puissance|compute|math|run_js|outil|algorithm/i.test(text);
	const app = /game|html|playable|scene|page|\bapp\b|canvas|widget|snake|particule|particle|jeu|demo|démo|code/i.test(text);
	const tel = /telemetry|working set|\bram\b|expert|tok\/s/i.test(text);
	return TOOL_DEFS.filter((t) => {
		const n = t.function.name;
		if (n === "write_app") return app || !calc && !tel;
		if (n === "run_js") return calc || !app && !tel;
		if (n === "device_telemetry") return tel;
		return false;
	});
}
function formatJs(raw, french) {
	try {
		const parsed = JSON.parse(raw);
		if (parsed.error) return parsed.error;
		const value = [parsed.result, ...parsed.logs ?? []].filter((x) => typeof x === "string" && x.length > 0)[0] ?? raw;
		return french ? `Résultat : ${value}` : `Result: ${value}`;
	} catch {
		return raw.slice(0, 400);
	}
}
async function completeTurn({ apiKey, messages, send, tools, maxTokens }) {
	const reader = (await startCompletion(apiKey, {
		stream: true,
		max_tokens: maxTokens,
		temperature: .4,
		messages,
		...tools && tools.length > 0 ? {
			tools,
			tool_choice: "auto"
		} : {}
	})).body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let content = "";
	let streamedContent = false;
	const toolMap = /* @__PURE__ */ new Map();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) continue;
			const data = trimmed.slice(5).trim();
			if (!data || data === "[DONE]") continue;
			let json;
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const delta = json.choices?.[0]?.delta;
			if (!delta) continue;
			const reasoning = delta.reasoning_content ?? delta.reasoning;
			if (reasoning) send({
				type: "thinking",
				text: reasoning
			});
			if (delta.content) {
				content += delta.content;
				send({
					type: "token",
					text: delta.content
				});
				streamedContent = true;
			}
			if (delta.tool_calls) for (const part of delta.tool_calls) {
				const index = part.index ?? 0;
				const current = toolMap.get(index) ?? {
					id: part.id ?? `call_${index}`,
					type: "function",
					function: {
						name: "",
						arguments: ""
					}
				};
				if (part.id) current.id = part.id;
				if (part.function?.name) current.function.name += part.function.name;
				if (part.function?.arguments) current.function.arguments += part.function.arguments;
				toolMap.set(index, current);
			}
		}
	}
	return {
		content,
		toolCalls: [...toolMap.values()].filter((t) => t.function.name),
		streamedContent
	};
}
async function startCompletion(apiKey, payload) {
	const models = cachedUpstream ? [cachedUpstream] : [...FAST_MODELS];
	let lastStatus = 502;
	for (const model of models) {
		const body = {
			...payload,
			model
		};
		if (model.includes("4.5") || model.endsWith("-reasoning")) body.reasoning_effort = "low";
		const res = await fetch("https://api.x.ai/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify(body)
		});
		if (res.ok && res.body) {
			cachedUpstream = model;
			return res;
		}
		lastStatus = res.status;
		if (res.status !== 400 && res.status !== 404) throw new Error(`Inference error ${res.status}`);
	}
	throw new Error(`Inference error ${lastStatus}`);
}
function safeParse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return raw.slice(0, 240);
	}
}
var rootRouteChildren = {
	IndexRoute: Route$1.update({
		id: "/",
		path: "/",
		getParentRoute: () => Route$2
	}),
	ApiChatRoute: Route.update({
		id: "/api/chat",
		path: "/api/chat",
		getParentRoute: () => Route$2
	})
};
var routeTree = Route$2._addFileChildren(rootRouteChildren)._addFileTypes();
var router_exports = /* @__PURE__ */ __exportAll({ getRouter: () => getRouter });
function getRouter() {
	return createRouter({
		routeTree,
		defaultErrorComponent: AppErrorComponent
	});
}
//#endregion
export { SEED_REPLY as a, newId as c, SEED_PROMPT as i, toolLabel as l, resolveLocalTurn as n, SUGGESTIONS as o, MODELS as r, extractHtmlBlock as s, router_exports as t };
