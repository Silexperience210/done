import { isFrench } from "@/lib/edge0";

export type LocalApp = {
  title: string;
  html: string;
  note: string;
  tool: string;
};

export function matchLocalApp(text: string): LocalApp | null {
  const t = text.toLowerCase();
  const fr = isFrench(text);

  if (/pong|ping[\s-]?pong|pingpong|tree\.js|three\.?js/.test(t)) return pingPong(fr);
  if (/snake/.test(t)) return snake(fr);
  if (/particule|particle/.test(t)) return particles(fr);
  if (/jeu|game|playable|canvas|widget|mini[\s-]?jeu|html/.test(t)) return pingPong(fr);
  return null;
}

export function fallbackApp(text: string): LocalApp {
  return pingPong(isFrench(text));
}

export function localChat(text: string): string {
  const fr = isFrench(text);
  const t = text.toLowerCase();
  if (/stream/.test(t)) {
    return fr
      ? "L’inférence streamée émet les tokens un par un, dès qu’ils sont calculés, au lieu d’attendre la séquence entière."
      : "Streaming inference emits tokens one by one as they are computed, instead of waiting for the full sequence.";
  }
  if (/ram|mémoire|memory|working set|modèle|model|local/.test(t)) {
    return fr
      ? "Tout tient dans la mémoire de l'appareil : environ 0,9 Go pour Qwen2.5-Coder-1.5B en 4 bits (1,0 Go à télécharger une fois). Rien ne part sur le réseau."
      : "Everything fits in the device's memory: about 0.9 GB for Qwen2.5-Coder-1.5B at 4 bits (1.0 GB downloaded once). Nothing goes over the network.";
  }
  return fr
    ? "Les mini-apps locales (ping-pong, snake, particules, calculs) fonctionnent sans réseau ni modèle. Pour une vraie conversation, le petit modèle local — Qwen2.5-Coder-1.5B, exécuté dans la page — prend le relais."
    : "Local mini-apps (ping pong, snake, particles, math) run without network or model. For real conversation, the small local model — Qwen2.5-Coder-1.5B, running in the page — takes over.";
}

export type LocalTurn =
  | { kind: "app"; app: LocalApp }
  | { kind: "calc"; expression: string; value: string; note: string }
  | { kind: "chat"; content: string };

export function resolveLocalTurn(text: string, force = false): LocalTurn {
  const app = matchLocalApp(text);
  if (app) return { kind: "app", app };
  const calc = matchLocalCalc(text);
  if (calc) {
    return {
      kind: "calc",
      expression: calc.expression,
      value: calc.value,
      note: isFrench(text) ? `Résultat : ${calc.value}` : `Result: ${calc.value}`,
    };
  }
  if (force && /jeu|game|html|canvas|code|widget|app|playable/.test(text.toLowerCase())) {
    return { kind: "app", app: fallbackApp(text) };
  }
  return { kind: "chat", content: localChat(text) };
}

export function matchLocalCalc(text: string): { expression: string; value: string } | null {
  const pow = text.match(/(\d+(?:\.\d+)?)\s*(?:\^|puissance|\*\*)\s*(\d{1,4})/i);
  if (pow) {
    const a = Number(pow[1]);
    const b = Number(pow[2]);
    if (b > 12) return null;
    const value = String(a ** b);
    return { expression: `${pow[1]}^${pow[2]}`, value };
  }
  const simple = text.match(/calcule\s+([\d\s+\-*/().]+)/i);
  if (simple) {
    const expr = simple[1].replace(/\s+/g, "");
    if (!/^[\d+\-*/().]+$/.test(expr)) return null;
    try {
      const value = Function(`"use strict"; return (${expr})`)();
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return { expression: expr, value: String(value) };
    } catch {
      return null;
    }
  }
  return null;
}

function pingPong(fr: boolean): LocalApp {
  return {
    title: "Ping Pong",
    tool: "write_app",
    note: fr
      ? "Ping-pong prêt. Touche l’écran pour jouer — pas besoin de code."
      : "Ping pong is ready. Tap the screen to play — no coding.",
    html: PONG_HTML,
  };
}

function snake(fr: boolean): LocalApp {
  return {
    title: "Snake",
    tool: "write_app",
    note: fr
      ? "Snake est dans le studio. Swipe pour jouer."
      : "Snake is in the studio. Swipe to play.",
    html: SNAKE_HTML,
  };
}

function particles(fr: boolean): LocalApp {
  return {
    title: "Particles",
    tool: "write_app",
    note: fr
      ? "Canvas de particules lancé. Bouge le doigt."
      : "Particle canvas is running. Drag to stir.",
    html: PARTICLES_HTML,
  };
}

const PONG_HTML = `<!DOCTYPE html>
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
</script>
</body>
</html>`;

const SNAKE_HTML = `<!DOCTYPE html>
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
</script></body></html>`;

const PARTICLES_HTML = `<!DOCTYPE html>
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
</script></body></html>`;
