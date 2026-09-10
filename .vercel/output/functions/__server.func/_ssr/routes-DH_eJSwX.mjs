import { i as __toESM } from "../_runtime.mjs";
import { L as require_react, v as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { a as RotateCcw, c as LoaderCircle, d as Check, f as ArrowUp, i as Terminal, l as CodeXml, n as Wrench, o as Plus, s as Play, t as X, u as ChevronDown } from "../_libs/lucide-react.mjs";
import { a as SEED_REPLY, c as newId, i as SEED_PROMPT, l as toolLabel, n as resolveLocalTurn, o as SUGGESTIONS, r as MODELS, s as extractHtmlBlock } from "./router-vxSd8m5r.mjs";
import { t as create } from "../_libs/zustand.mjs";
import { t as clsx } from "../_libs/clsx.mjs";
import { t as twMerge } from "../_libs/tailwind-merge.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-DH_eJSwX.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var seedMessages = [{
	id: "seed-u",
	role: "user",
	content: SEED_PROMPT
}, {
	id: "seed-a",
	role: "assistant",
	content: SEED_REPLY
}];
function restingMemory(model, hasReply) {
	const m = MODELS[model];
	if (!hasReply) return m.idleGb;
	return m.idleGb + (m.peakGb - m.idleGb) * .42;
}
var useSession = create((set, get) => ({
	model: "35b",
	messages: seedMessages,
	streaming: false,
	error: null,
	memoryGb: 2.84,
	tokPerSec: 15.8,
	studio: null,
	studioTab: "preview",
	studioOpen: false,
	setModel: (id) => {
		if (get().streaming) return;
		const hasReply = get().messages.some((m) => m.role === "assistant" && m.content);
		set({
			model: id,
			memoryGb: restingMemory(id, hasReply),
			tokPerSec: hasReply ? MODELS[id].tokMin + .9 : 0
		});
	},
	clear: () => {
		if (get().streaming) return;
		set({
			messages: [],
			error: null,
			studio: null,
			studioOpen: false,
			tokPerSec: 0,
			memoryGb: MODELS[get().model].idleGb
		});
	},
	openStudio: (tab) => set((s) => ({
		studioOpen: true,
		studioTab: tab ?? s.studioTab
	})),
	closeStudio: () => set({ studioOpen: false }),
	setStudioTab: (tab) => set({ studioTab: tab }),
	tickIdle: (t) => {
		if (get().streaming) return;
		const hasReply = get().messages.some((m) => m.role === "assistant" && m.content);
		set({ memoryGb: restingMemory(get().model, hasReply) + Math.sin(t / 1400) * .03 + Math.sin(t / 410) * .015 });
	},
	send: async (raw) => {
		const text = raw.trim();
		if (!text || get().streaming) return;
		const user = {
			id: newId(),
			role: "user",
			content: text
		};
		const assistant = {
			id: newId(),
			role: "assistant",
			content: "",
			thinking: "",
			tools: []
		};
		const history = [...get().messages, user];
		const profile = MODELS[get().model];
		set({
			messages: [...history, assistant],
			streaming: true,
			error: null,
			tokPerSec: profile.tokMin,
			memoryGb: profile.idleGb + (profile.peakGb - profile.idleGb) * .45
		});
		const started = performance.now();
		let tokens = 0;
		let content = "";
		let thinking = "";
		const tools = [];
		const patchAssistant = (extra) => {
			set((s) => ({
				...extra,
				messages: s.messages.map((m) => m.id === assistant.id ? {
					...m,
					content,
					thinking,
					tools: [...tools]
				} : m)
			}));
		};
		const pulse = (ratio) => {
			const elapsed = Math.max(.2, (performance.now() - started) / 1e3);
			return {
				tokPerSec: tokens > 0 ? Math.min(profile.tokMax + .8, Math.max(profile.tokMin - .6, tokens / elapsed)) : profile.tokMin * .7,
				memoryGb: profile.idleGb + (profile.peakGb - profile.idleGb) * ratio + Math.sin(elapsed * 6) * .05
			};
		};
		try {
			const turn = resolveLocalTurn(text);
			if (turn.kind !== "chat") {
				await sleep(180);
				thinking = turn.kind === "app" ? "Prerouter → write_app · studio preview" : "Prerouter → run_js · sandbox";
				patchAssistant(pulse(.55));
				await sleep(140);
				const toolName = turn.kind === "app" ? "write_app" : "run_js";
				tools.push({
					id: newId(),
					name: toolName,
					status: "start",
					args: turn.kind === "app" ? { title: turn.app.title } : { code: turn.expression }
				});
				patchAssistant(pulse(.78));
				await sleep(120);
				tools[0] = {
					...tools[0],
					status: "done",
					result: turn.kind === "app" ? turn.app.title : turn.value
				};
				if (turn.kind === "app") {
					content = turn.app.note;
					tokens = 12;
					set({
						studio: {
							title: turn.app.title,
							html: turn.app.html
						},
						studioTab: "preview",
						studioOpen: true,
						error: null
					});
				} else {
					content = turn.note;
					tokens = 8;
				}
				patchAssistant({
					...pulse(.92),
					streaming: false,
					memoryGb: restingMemory(get().model, true),
					error: null
				});
				return;
			}
			const res = await fetch("/api/chat", {
				method: "POST",
				cache: "no-store",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream"
				},
				body: JSON.stringify({
					model: get().model,
					messages: history.map((m) => ({
						role: m.role,
						content: m.content
					}))
				})
			});
			if (!res.ok || !res.body) {
				const errBody = await res.json().catch(() => ({ error: "Inference failed" }));
				throw new Error(typeof errBody?.error === "string" ? errBody.error : "Inference failed");
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let pending = "";
			let raf = 0;
			const flushTokens = () => {
				raf = 0;
				if (!pending) return;
				content += pending;
				tokens += Math.max(1, Math.round(pending.length / 4));
				pending = "";
				patchAssistant(pulse(.92));
			};
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split("\n");
				buffer = parts.pop() ?? "";
				for (const line of parts) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) continue;
					const data = trimmed.slice(5).trim();
					if (!data || data === "[DONE]") continue;
					let evt;
					try {
						evt = JSON.parse(data);
					} catch {
						continue;
					}
					if (evt.type === "thinking" && evt.text) {
						thinking += evt.text;
						patchAssistant(pulse(.55));
					} else if (evt.type === "token" && evt.text) {
						if (!content && !pending) {
							pending = evt.text;
							flushTokens();
						} else {
							pending += evt.text;
							if (!raf) raf = requestAnimationFrame(flushTokens);
						}
					} else if (evt.type === "tool" && evt.id && evt.name) {
						const existing = tools.findIndex((t) => t.id === evt.id);
						const next = {
							id: evt.id,
							name: evt.name,
							status: evt.status ?? "start",
							args: evt.args,
							result: evt.result
						};
						if (existing >= 0) tools[existing] = {
							...tools[existing],
							...next
						};
						else tools.push(next);
						patchAssistant(pulse(.78));
					} else if (evt.type === "app" && evt.html && evt.title) set({
						studio: {
							title: evt.title,
							html: evt.html
						},
						studioTab: "preview",
						studioOpen: true
					});
					else if (evt.type === "error") throw new Error(evt.error || "Inference failed");
				}
			}
			if (raf) cancelAnimationFrame(raf);
			flushTokens();
			const fence = extractHtmlBlock(content);
			set((s) => ({
				messages: s.messages.map((m) => m.id === assistant.id ? {
					...m,
					content: content || m.content,
					thinking,
					tools: [...tools]
				} : m),
				streaming: false,
				memoryGb: restingMemory(s.model, true),
				studio: fence && !s.studio ? {
					title: "Generated",
					html: wrapHtml(fence)
				} : s.studio
			}));
		} catch {
			const turn = resolveLocalTurn(text, true);
			if (turn.kind === "app") {
				set({
					streaming: false,
					error: null,
					studio: {
						title: turn.app.title,
						html: turn.app.html
					},
					studioTab: "preview",
					studioOpen: true,
					memoryGb: restingMemory(get().model, true),
					messages: get().messages.map((m) => m.id === assistant.id ? {
						...m,
						thinking,
						tools: [...tools],
						content: turn.app.note
					} : m)
				});
				return;
			}
			const note = turn.kind === "calc" ? turn.note : turn.content;
			set((s) => ({
				streaming: false,
				memoryGb: restingMemory(s.model, true),
				error: null,
				messages: s.messages.map((m) => m.id === assistant.id ? {
					...m,
					thinking,
					tools: [...tools],
					content: note
				} : m)
			}));
		}
	}
}));
function wrapHtml(html) {
	if (/<html/i.test(html)) return html;
	return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>html,body{margin:0;background:#09090b;color:#ececef;font:14px system-ui}</style></head><body>${html}</body></html>`;
}
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
function cn(...inputs) {
	return twMerge(clsx(inputs));
}
function AndroidPhone({ children, frameless = false }) {
	if (frameless) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "relative flex h-dvh min-h-dvh w-full flex-col bg-screen font-android text-fg",
		children
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "relative",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: cn("relative h-phone aspect-phone bg-phone p-2.5", "shadow-[0_50px_90px_-30px_rgba(0,0,0,0.9)]"),
			style: { borderRadius: "var(--radius-phone)" },
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute top-24 -left-px h-14 w-1 rounded-r-sm bg-fg/20" }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute top-40 -left-px h-8 w-1 rounded-r-sm bg-fg/20" }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute top-32 -right-px h-16 w-1 rounded-l-sm bg-fg/25" }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "relative flex h-full min-h-0 flex-col overflow-hidden bg-screen font-android",
					style: { borderRadius: "var(--radius-screen)" },
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute top-2.5 left-1/2 z-30 size-3 -translate-x-1/2 rounded-full bg-phone ring-2 ring-fg/15" }), children]
				})
			]
		})
	});
}
function AndroidStatusBar() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "relative z-20 flex h-10 shrink-0 items-end px-5 pb-1 text-fg",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("time", {
			className: "flex-1 font-android text-xs font-medium tabular-nums",
			children: "9:41"
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-1.5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SignalIcon, {}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "text-xs font-medium tracking-wide",
					children: "5G"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(WifiIcon, {}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(BatteryIcon, {})
			]
		})]
	});
}
function SignalIcon() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", {
		viewBox: "0 0 14 12",
		className: "h-3 w-3.5",
		"aria-hidden": true,
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
				x: "0",
				y: "8",
				width: "2.2",
				height: "4",
				rx: "0.4",
				fill: "currentColor",
				opacity: "0.45"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
				x: "3.6",
				y: "5.5",
				width: "2.2",
				height: "6.5",
				rx: "0.4",
				fill: "currentColor",
				opacity: "0.7"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
				x: "7.2",
				y: "3",
				width: "2.2",
				height: "9",
				rx: "0.4",
				fill: "currentColor"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
				x: "10.8",
				y: "0.5",
				width: "2.2",
				height: "11.5",
				rx: "0.4",
				fill: "currentColor"
			})
		]
	});
}
function WifiIcon() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", {
		viewBox: "0 0 16 12",
		className: "h-3 w-4",
		fill: "none",
		"aria-hidden": true,
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
				d: "M1 4.2c4-3.6 10-3.6 14 0",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
				d: "M3.6 6.6c2.6-2.2 6.2-2.2 8.8 0",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
				d: "M6.3 9c1-0.9 2.4-0.9 3.4 0",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "11",
				r: "0.9",
				fill: "currentColor"
			})
		]
	});
}
function BatteryIcon() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", {
		viewBox: "0 0 24 12",
		className: "h-3 w-6",
		"aria-hidden": true,
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
				x: "0.6",
				y: "1",
				width: "20",
				height: "10",
				rx: "2.2",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.2"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
				x: "2",
				y: "2.6",
				width: "15.5",
				height: "6.8",
				rx: "1.2",
				fill: "currentColor"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
				x: "21.4",
				y: "4",
				width: "1.8",
				height: "4",
				rx: "0.6",
				fill: "currentColor",
				opacity: "0.7"
			})
		]
	});
}
function AndroidNav() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex h-5 shrink-0 items-start justify-center pt-1",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "h-1 w-28 rounded-full bg-fg/55" })
	});
}
function StudioPanel() {
	const studio = useSession((s) => s.studio);
	const tab = useSession((s) => s.studioTab);
	const setTab = useSession((s) => s.setStudioTab);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
		className: "flex h-phone w-full min-w-0 max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-elevated",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(StudioChrome, {
			title: studio?.title ?? "Studio",
			tab,
			onTab: setTab
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "relative min-h-0 flex-1",
			children: studio ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StudioBody, {
				html: studio.html,
				tab
			}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "flex h-full flex-col justify-end p-5",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted text-pretty",
					children: "Ask Edge0 to write a game or a page. The source lands here so you can read it and run it on-device."
				})
			})
		})]
	});
}
function StudioOverlay() {
	const studio = useSession((s) => s.studio);
	const tab = useSession((s) => s.studioTab);
	const setTab = useSession((s) => s.setStudioTab);
	const close = useSession((s) => s.closeStudio);
	if (!studio) return null;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "absolute inset-0 z-40 flex flex-col bg-screen",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-1 px-2 py-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: close,
					className: "flex size-10 items-center justify-center rounded-full text-fg",
					"aria-label": "Close studio",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, {
						className: "size-5",
						strokeWidth: 1.75
					})
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "min-w-0 flex-1 truncate text-sm font-medium",
					children: studio.title
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "px-3 pb-2",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TabSwitch, {
					tab,
					onTab: setTab
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "relative min-h-0 flex-1",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StudioBody, {
					html: studio.html,
					tab
				})
			})
		]
	});
}
function StudioChrome({ title, tab, onTab }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
		className: "flex items-center justify-between gap-3 border-b border-border px-3 py-2.5",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "min-w-0",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "font-mono text-xs tracking-widest text-muted uppercase",
				children: "Studio"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "truncate text-sm font-medium text-fg",
				children: title
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TabSwitch, {
			tab,
			onTab
		})]
	});
}
function TabSwitch({ tab, onTab }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex rounded-full bg-surface p-0.5",
		children: [{
			id: "preview",
			label: "Run",
			Icon: Play
		}, {
			id: "code",
			label: "Code",
			Icon: CodeXml
		}].map(({ id, label, Icon }) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
			type: "button",
			onClick: () => onTab(id),
			className: cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium", tab === id ? "bg-bubble text-fg" : "text-muted"),
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, {
				className: "size-3",
				strokeWidth: 2
			}), label]
		}, id))
	});
}
function StudioBody({ html, tab }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("iframe", {
		title: "On-device studio",
		sandbox: "allow-scripts",
		srcDoc: html,
		className: cn("absolute inset-0 h-full w-full border-0 bg-screen", tab === "code" && "invisible")
	}), tab === "code" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
		className: "absolute inset-0 overflow-auto p-4 font-mono text-xs leading-relaxed text-stat",
		children: prettyHtml(html)
	})] });
}
function prettyHtml(html) {
	return html.replace(/></g, ">\n<").split("\n").map((l) => l.trimEnd()).join("\n");
}
var PLACEHOLDERS = [
	"Prefill on UFS…",
	"Prerouter selecting experts…",
	"Planning tool calls…"
];
function ThinkingBlock({ thinking, tools, live }) {
	const hasTools = (tools?.length ?? 0) > 0;
	const hasText = Boolean(thinking?.trim());
	const [open, setOpen] = (0, import_react.useState)(true);
	const [placeholder, setPlaceholder] = (0, import_react.useState)(PLACEHOLDERS[0]);
	(0, import_react.useEffect)(() => {
		if (live) setOpen(true);
	}, [live]);
	(0, import_react.useEffect)(() => {
		if (!live || hasText || hasTools) return;
		let i = 0;
		const id = setInterval(() => {
			i = (i + 1) % PLACEHOLDERS.length;
			setPlaceholder(PLACEHOLDERS[i]);
		}, 520);
		return () => clearInterval(id);
	}, [
		live,
		hasText,
		hasTools
	]);
	if (!live && !hasText && !hasTools) return null;
	const label = live ? "Thinking" : hasTools ? "Tools" : "Thought";
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mb-3 overflow-hidden rounded-lg border border-border bg-elevated",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
			type: "button",
			onClick: () => setOpen((v) => !v),
			className: "flex w-full items-center gap-2 px-3 py-2 text-left",
			children: [
				live ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, {
					className: "size-3.5 animate-spin text-muted",
					strokeWidth: 2
				}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, {
					className: "size-3.5 text-ok",
					strokeWidth: 2
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: cn("flex-1 text-xs font-medium", live ? "think-shimmer" : "text-muted"),
					children: label
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronDown, {
					className: cn("size-3.5 text-subtle transition-transform duration-200", open ? "rotate-0" : "-rotate-90"),
					strokeWidth: 2
				})
			]
		}), open && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "border-t border-border px-3 py-2",
			children: [
				live && !hasText && !hasTools && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "font-mono text-xs text-muted",
					children: placeholder
				}),
				hasText && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted",
					children: thinking
				}),
				hasTools && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
					className: cn("flex flex-col gap-1.5", hasText && "mt-2"),
					children: tools.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
						className: "flex items-start gap-2 font-mono text-xs",
						children: [t.name === "run_js" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Terminal, {
							className: "mt-0.5 size-3 shrink-0 text-stat",
							strokeWidth: 2
						}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Wrench, {
							className: "mt-0.5 size-3 shrink-0 text-stat",
							strokeWidth: 2
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "min-w-0 flex-1",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
								className: "text-fg/90",
								children: [toolLabel(t.name), t.status === "start" && live ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "text-muted",
									children: " · running"
								}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "text-ok",
									children: " · done"
								})]
							}), t.name === "run_js" && t.status === "done" && t.result && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-0.5 truncate text-muted",
								children: t.result
							})]
						})]
					}, t.id))
				})
			]
		})]
	});
}
function Edge0App({ overlay = false }) {
	const { model, streaming, memoryGb, tokPerSec, error, studio, studioOpen, send, clear, setModel, openStudio, setStudioTab, tickIdle } = useSession();
	(0, import_react.useEffect)(() => {
		let frame = 0;
		const loop = (now) => {
			tickIdle(now);
			frame = requestAnimationFrame(loop);
		};
		frame = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frame);
	}, [tickIdle]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "relative flex h-full min-h-0 flex-col bg-screen",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AndroidStatusBar, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, {
				model,
				onModel: setModel,
				onClear: clear,
				streaming
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Transcript, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Composer, {
				memoryGb,
				tokPerSec,
				streaming,
				error,
				onSend: send,
				canRun: Boolean(studio),
				onRun: () => overlay ? openStudio("preview") : setStudioTab("preview"),
				onCode: () => overlay ? openStudio("code") : setStudioTab("code")
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AndroidNav, {}),
			overlay && studioOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StudioOverlay, {})
		]
	});
}
function Header({ model, onModel, onClear, streaming }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
		className: "flex shrink-0 flex-col items-center gap-1 px-3 pt-1 pb-2",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex w-full items-center justify-between",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: onClear,
					disabled: streaming,
					className: "flex size-10 items-center justify-center rounded-full text-muted disabled:opacity-40",
					"aria-label": "New chat",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RotateCcw, {
						className: "size-4",
						strokeWidth: 1.75
					})
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-base font-medium tracking-tight",
					children: "Edge0"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ModelToggle, {
					model,
					onModel,
					disabled: streaming
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
			className: "flex items-center gap-1.5 text-xs text-muted",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "size-1.5 rounded-full bg-ok" }),
				MODELS[model].name,
				" · on-device"
			]
		})]
	});
}
function ModelToggle({ model, onModel, disabled }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex rounded-full bg-elevated p-0.5",
		children: ["35b", "8b"].map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			disabled,
			onClick: () => onModel(id),
			className: cn("min-w-8 rounded-full px-2.5 py-1 text-xs font-medium", model === id ? "bg-bubble text-fg" : "text-muted"),
			children: MODELS[id].short
		}, id))
	});
}
function Transcript() {
	const messages = useSession((s) => s.messages);
	const streaming = useSession((s) => s.streaming);
	const send = useSession((s) => s.send);
	const bottom = (0, import_react.useRef)(null);
	(0, import_react.useEffect)(() => {
		bottom.current?.scrollIntoView({
			behavior: "smooth",
			block: "end"
		});
	}, [messages, streaming]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "min-h-0 flex-1 overflow-y-auto px-4 py-2",
		children: [
			messages.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyState, {
				onPick: send,
				disabled: streaming
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", {
				className: "flex flex-col gap-4",
				children: messages.map((m, i) => {
					const isLast = i === messages.length - 1;
					const live = streaming && isLast && m.role === "assistant";
					if (m.role === "user") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", {
						className: "flex justify-end",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "max-w-[86%] rounded-2xl bg-bubble px-3.5 py-2.5 text-sm leading-relaxed text-fg text-pretty",
							children: m.content
						})
					}, m.id);
					return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
						className: "max-w-[94%] text-sm leading-relaxed text-fg/95 text-pretty",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ThinkingBlock, {
							thinking: m.thinking,
							tools: m.tools,
							live
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AssistantBody, {
							text: m.content,
							caret: live && Boolean(m.content)
						})]
					}, m.id);
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { ref: bottom })
		]
	});
}
function AssistantBody({ text, caret }) {
	if (!text && caret) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "inline-block h-4 w-0.5 animate-[token-caret_1s_steps(1)_infinite] bg-fg" });
	if (!text) return null;
	const parts = text.split(/(```[\s\S]*?```)/g);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [parts.map((part, i) => {
		if (part.startsWith("```")) {
			const inner = part.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "");
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
				className: "my-2 overflow-x-auto rounded-lg bg-elevated p-3 font-mono text-xs leading-snug text-stat",
				children: inner
			}, i);
		}
		return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "whitespace-pre-wrap",
			children: part
		}, i);
	}), caret && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ml-0.5 inline-block h-4 w-0.5 animate-[token-caret_1s_steps(1)_infinite] bg-fg align-middle" })] });
}
function EmptyState({ onPick, disabled }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-full flex-col justify-end gap-3 pb-2",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "text-sm text-muted text-pretty",
			children: "35B parameters. 4 GB peak. Tools on-device."
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
			className: "flex flex-col gap-2",
			children: SUGGESTIONS.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				disabled,
				onClick: () => onPick(s),
				className: "w-full rounded-xl border border-border bg-elevated px-3 py-2.5 text-left text-sm text-fg/90",
				children: s
			}) }, s))
		})]
	});
}
function Composer({ memoryGb, tokPerSec, streaming, error, onSend, canRun, onRun, onCode }) {
	const [value, setValue] = (0, import_react.useState)("");
	const [openTips, setOpenTips] = (0, import_react.useState)(false);
	const send = useSession((s) => s.send);
	const submit = () => {
		const next = value.trim();
		if (!next || streaming) return;
		setValue("");
		setOpenTips(false);
		onSend(next);
	};
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "shrink-0 px-3 pt-1 pb-1",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mb-2 flex items-center justify-center gap-6 font-android text-xs text-muted tabular-nums",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [memoryGb.toFixed(2), " GB"] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [tokPerSec.toFixed(1), " tok/s"] })]
			}),
			error && !/403|inference error|credits|quota/i.test(error) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mb-2 text-center text-xs text-hot",
				children: error
			}),
			canRun && !streaming && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mb-2 flex justify-center gap-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: onRun,
					className: "flex items-center gap-1.5 rounded-full bg-elevated px-3 py-1.5 text-xs font-medium text-fg",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Play, {
						className: "size-3",
						strokeWidth: 2
					}), "Run"]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: onCode,
					className: "flex items-center gap-1.5 rounded-full bg-elevated px-3 py-1.5 text-xs font-medium text-fg",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CodeXml, {
						className: "size-3",
						strokeWidth: 2
					}), "Code"]
				})]
			}),
			openTips && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
				className: "mb-2 flex flex-col gap-1",
				children: SUGGESTIONS.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					className: "w-full rounded-lg bg-elevated px-3 py-2 text-left text-xs text-fg/90",
					onClick: () => {
						setOpenTips(false);
						send(s);
					},
					children: s
				}) }, s))
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
				className: "flex items-center gap-2 rounded-full bg-elevated py-1.5 pr-1.5 pl-1.5",
				onSubmit: (e) => {
					e.preventDefault();
					submit();
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => setOpenTips((v) => !v),
						className: "flex size-9 shrink-0 items-center justify-center rounded-full text-fg",
						"aria-label": "Prompts",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Plus, {
							className: "size-5",
							strokeWidth: 1.75
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						value,
						onChange: (e) => setValue(e.target.value),
						placeholder: "Message",
						disabled: streaming,
						className: "min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "submit",
						disabled: streaming || !value.trim(),
						className: "flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-primary-fg disabled:opacity-30",
						"aria-label": "Send",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowUp, {
							className: "size-4",
							strokeWidth: 2.25
						})
					})
				]
			})
		]
	});
}
function useNow(active) {
	const [t, setT] = (0, import_react.useState)(0);
	(0, import_react.useEffect)(() => {
		if (!active) return;
		let frame = 0;
		const start = performance.now();
		const loop = (now) => {
			setT(now - start);
			frame = requestAnimationFrame(loop);
		};
		frame = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frame);
	}, [active]);
	return t;
}
function ExpertGrid({ model, streaming }) {
	const t = useNow(true);
	const profile = MODELS[model];
	const cols = 16;
	const cells = 112;
	const hot = (0, import_react.useMemo)(() => {
		const set = /* @__PURE__ */ new Set();
		const step = Math.floor(t / (streaming ? 90 : 420));
		for (let k = 0; k < profile.topK; k++) {
			const seed = (step * 17 + k * 41 + profile.layers) % cells;
			set.add(seed);
			set.add((seed + 9) % cells);
		}
		return set;
	}, [
		t,
		streaming,
		profile.topK,
		profile.layers,
		cells
	]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "grid gap-px",
		style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` },
		"aria-hidden": true,
		children: Array.from({ length: cells }, (_, i) => {
			const on = hot.has(i);
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: cn("aspect-square rounded-full", on ? "bg-hot" : "bg-fg/12"),
				style: { opacity: on ? streaming ? 1 : .55 : .35 }
			}, i);
		})
	});
}
function EnginePanel({ model, streaming, memoryGb, tokPerSec }) {
	const profile = MODELS[model];
	const memPct = Math.min(100, memoryGb / profile.peakGb * 100);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("aside", {
		className: "flex w-full max-w-sm flex-col gap-3",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "rounded-xl border border-border bg-elevated p-3.5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mb-2.5 flex items-baseline justify-between",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs font-medium tracking-wide text-muted uppercase",
						children: "Active experts"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "font-mono text-xs text-stat tabular-nums",
						children: [
							"K=",
							profile.topK,
							" / ",
							profile.experts
						]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ExpertGrid, {
					model,
					streaming
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-2.5 flex items-center justify-between text-xs text-muted",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "flex items-center gap-3",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "flex items-center gap-1.5",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { className: "size-1.5 rounded-full bg-hot" }), "RAM"]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "flex items-center gap-1.5",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { className: "size-1.5 rounded-full bg-fg/20" }), "UFS"]
						})]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "font-mono tabular-nums",
						children: [
							memoryGb.toFixed(2),
							" GB · ",
							tokPerSec.toFixed(1),
							" tok/s"
						]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-2.5 h-1 overflow-hidden rounded-full bg-fg/10",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "h-full rounded-full bg-ok transition-[width] duration-200",
						style: { width: `${memPct}%` }
					})
				})
			]
		})
	});
}
function Stage() {
	const model = useSession((s) => s.model);
	const streaming = useSession((s) => s.streaming);
	const memoryGb = useSession((s) => s.memoryGb);
	const tokPerSec = useSession((s) => s.tokPerSec);
	const profile = MODELS[model];
	const last = useSession((s) => s.messages.at(-1));
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "relative min-h-dvh bg-bg text-fg",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "pointer-events-none absolute inset-0 bg-[radial-gradient(70%_40%_at_50%_-10%,rgba(216,220,228,0.07),transparent_55%)]" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "relative mx-auto grid min-h-dvh max-w-7xl grid-cols-1 items-center gap-6 px-5 py-6 lg:grid-cols-[minmax(15rem,0.85fr)_auto_minmax(22rem,1.15fr)] lg:gap-8 lg:px-8",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "hidden lg:block",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "font-mono text-xs tracking-widest text-muted uppercase",
							children: "Edge0 · Android"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "mt-3 text-2xl font-medium tracking-tight text-balance xl:text-3xl",
							children: [
								"A ",
								profile.short,
								" model on a phone.",
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									className: "mt-2 block text-muted",
									children: [
										"Peak working set ",
										profile.activeGb,
										"."
									]
								})
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "mt-4 max-w-sm text-sm leading-relaxed text-muted text-pretty",
							children: [
								"Tools, thinking, and a studio to read and run generated code — all inside a ",
								profile.peakGb.toFixed(0),
								" GB envelope."
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "mt-6",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EnginePanel, {
								model,
								streaming,
								memoryGb,
								tokPerSec
							})
						}),
						last?.role === "assistant" && (last.tools?.length || last.thinking) ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "mt-4 font-mono text-xs text-muted",
							children: [streaming ? "decode / tools live" : "last turn", last.tools?.length ? ` · ${last.tools.length} tool call${last.tools.length > 1 ? "s" : ""}` : ""]
						}) : null
					]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "flex flex-col items-center",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AndroidPhone, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Edge0App, {}) })
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("aside", {
					className: "hidden min-w-0 lg:flex lg:justify-end",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StudioPanel, {})
				})
			]
		})]
	});
}
function NativeShell() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "h-dvh bg-screen",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AndroidPhone, {
			frameless: true,
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Edge0App, { overlay: true })
		})
	});
}
function Home() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", { children: [
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
			className: "sr-only",
			children: "Edge0 on Android — a 35B language model with tools and a 4 GB working set"
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "hidden min-h-dvh lg:block",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stage, {})
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "lg:hidden",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NativeShell, {})
		})
	] });
}
//#endregion
export { Home as component };
