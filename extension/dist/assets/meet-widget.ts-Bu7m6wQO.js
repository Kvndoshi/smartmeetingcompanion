var S=Object.defineProperty;var M=(c,t,e)=>t in c?S(c,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):c[t]=e;var i=(c,t,e)=>M(c,typeof t!="symbol"?t+"":t,e);import{I as E,A as h,L as T,l as u,s as C,a as B,b as v}from"./protocol-DUdwB3xn.js";const z=/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i,$=`
@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap");

:host {
  all: initial;
  font-family: "Outfit", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  --ios-blue: #007aff;
  --ios-blue-pressed: #0063d1;
  --ios-blue-glow: rgba(0, 122, 255, 0.35);
  --glass-1: rgba(28, 28, 30, 0.80);
  --glass-2: rgba(38, 38, 42, 0.88);
  --glass-3: rgba(52, 52, 58, 0.94);
  --glass-border: rgba(255, 255, 255, 0.12);
  --glass-border-focus: rgba(0, 122, 255, 0.55);
  --text: rgba(255, 255, 255, 0.95);
  --text2: rgba(255, 255, 255, 0.60);
  --muted: rgba(255, 255, 255, 0.34);
  --label: rgba(255, 255, 255, 0.42);
  --amber: #ff9f0a;
  --amber-dim: rgba(255, 159, 10, 0.15);
  --green: #30d158;
  --green-dim: rgba(48, 209, 88, 0.15);
  --red: #ff453a;
  --red-dim: rgba(255, 69, 58, 0.14);
  --r: 18px;
  --rs: 10px;
  --blur: blur(24px) saturate(180%);
}

*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── FAB (minimized) ── */
.fab {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: linear-gradient(160deg, var(--glass-3) 0%, var(--glass-1) 100%);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--glass-border);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  box-shadow: 0 8px 30px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.20);
}

.fab:hover {
  border-color: rgba(255,255,255,0.24);
  transform: scale(1.08);
  box-shadow: 0 12px 36px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.24);
}

.fab svg {
  width: 21px;
  height: 21px;
  color: var(--ios-blue);
}

.fab-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  border: 2px solid rgba(22, 22, 24, 0.92);
}

.fab-dot.capturing {
  background: var(--ios-blue);
  animation: fpulse 2s ease-in-out infinite;
}

.fab-dot.connected { background: var(--green); }
.fab-dot.error, .fab-dot.disconnected { background: var(--red); }

@keyframes fpulse {
  0%,100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ── Panel (expanded) ── */
.panel {
  width: 330px;
  background: linear-gradient(180deg, rgba(34, 34, 38, 0.96) 0%, rgba(24, 24, 28, 0.94) 100%);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--glass-border);
  border-radius: 22px;
  box-shadow: 0 18px 56px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.16);
  overflow: hidden;
  animation: panel-in 0.25s ease;
}

@keyframes panel-in {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* header */
.p-header {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 18px 16px 12px;
}

.p-logo {
  width: 34px;
  height: 34px;
  border-radius: 0;
  background: transparent;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.p-logo svg { width: 18px; height: 18px; color: var(--ios-blue); }

.p-title-wrap {
  flex: 1;
  min-width: 0;
}

.p-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.4px;
  line-height: 1.12;
}

.p-subtitle {
  margin-top: 2px;
  font-size: 9px;
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1.2px;
}

.p-waveform {
  width: 34px;
  height: 18px;
  color: var(--muted);
  transition: color 0.4s;
}

.p-waveform.active { color: var(--ios-blue); }

.p-minimize {
  width: 28px;
  height: 28px;
  background: var(--glass-1);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  font-size: 14px;
  line-height: 1;
}

.p-minimize:hover {
  color: var(--text2);
  background: var(--glass-2);
  border-color: rgba(255,255,255,0.2);
}

/* status */
.p-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 13px;
  margin: 0 12px;
  background: linear-gradient(135deg, var(--glass-2) 0%, var(--glass-1) 100%);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  box-shadow: 0 1px 6px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.18);
  font-size: 11.5px;
  color: var(--text2);
  font-weight: 500;
}

.s-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
  position: relative;
}

.s-dot::after {
  content: "";
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  background: transparent;
}

.s-dot.capturing {
  background: var(--ios-blue);
  animation: fpulse 2s ease-in-out infinite;
}

.s-dot.capturing::after {
  background: var(--ios-blue-glow);
}

.s-dot.connected { background: var(--green); }
.s-dot.waiting { background: var(--amber); }
.s-dot.waiting::after { background: var(--amber-dim); }
.s-dot.connected::after { background: var(--green-dim); }
.s-dot.error, .s-dot.disconnected { background: var(--red); }
.s-dot.error::after, .s-dot.disconnected::after { background: var(--red-dim); }

/* body */
.p-body {
  padding: 12px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* languages */
.langs {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  overflow: hidden;
  padding: 3px;
  background: linear-gradient(145deg, var(--glass-3) 0%, var(--glass-1) 100%);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.18);
}

.langs select {
  flex: 1;
  min-width: 0;
  padding: 9px 28px 9px 12px;
  background: transparent;
  border: none;
  border-radius: var(--rs);
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 16 10'%3E%3Cpath d='M1 1l7 7 7-7' stroke='rgba(255,255,255,0.35)' stroke-width='2' stroke-linecap='round' fill='none'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  transition: background 0.2s;
}

.langs select:focus {
  outline: none;
  background-color: var(--glass-2);
}

.langs select:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.langs select option {
  background: #2c2c2e;
  color: var(--text);
}

/* groups: My language / What I hear / What they hear */
.w-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.w-label {
  font-size: 9.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.9px;
  color: var(--muted);
}

.w-group {
  --g: #0a84ff;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 10px 10px;
  border-radius: 12px;
  border: 1px solid var(--glass-border);
  border-left: 3px solid var(--g);
  background: color-mix(in srgb, var(--g) 7%, transparent);
}

.w-group.speak { --g: #bf5af2; }

.w-group .w-label { color: var(--g); display: flex; align-items: center; gap: 6px; }
.w-group .w-label svg { width: 12px; height: 12px; }

.w-hint {
  font-size: 10px;
  color: var(--muted);
  line-height: 1.35;
}

/* action button */
.action-btn {
  width: 100%;
  padding: 13px 14px;
  border: none;
  border-radius: 999px;
  font-size: 13.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}

.action-btn svg { width: 13px; height: 13px; }

.action-btn.start {
  background: linear-gradient(160deg, #3395ff 0%, #007aff 50%, #005ecb 100%);
  color: #ffffff;
  box-shadow: 0 4px 20px var(--ios-blue-glow), inset 0 1px 0 rgba(255,255,255,0.22);
}

.action-btn.start:hover {
  box-shadow: 0 6px 28px rgba(0, 122, 255, 0.45);
  opacity: 0.94;
}

.action-btn.stop {
  background: linear-gradient(160deg, var(--glass-3) 0%, var(--glass-1) 100%);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  color: var(--text);
  border: 1px solid var(--glass-border);
  box-shadow: 0 2px 10px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.16);
}

.action-btn.stop:hover {
  background: var(--glass-3);
}

.action-btn:active {
  transform: scale(0.98);
}

/* transcript */
.transcript {
  background: linear-gradient(160deg, var(--glass-2) 0%, rgba(0,0,0,0.10) 100%);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--glass-border);
  border-radius: var(--rs);
  padding: 12px 13px;
  max-height: 150px;
  min-height: 60px;
  overflow-y: auto;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text2);
  box-shadow: inset 0 2px 8px rgba(0,0,0,0.14);
}

.transcript::-webkit-scrollbar { width: 3px; }
.transcript::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }

.t-entry {
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  animation: tup 0.3s ease;
}

.t-entry:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }

.t-orig { color: var(--muted); font-size: 10.5px; font-style: italic; margin-bottom: 3px; }
.t-trans { color: var(--text); font-weight: 500; font-size: 12.5px; }

.t-empty {
  color: var(--muted);
  text-align: center;
  padding: 18px 0;
  font-size: 11px;
}

@keyframes tup {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* waveform SVG */
.wf .wf-bar {
  transform-origin: center;
  transform: scaleY(1);
  transition: transform 0.3s;
}

.wf.active .wf-bar {
  animation: wfd 0.7s ease-in-out infinite alternate;
}

.wf.active .wf-bar:nth-child(1) { animation-delay: 0ms; }
.wf.active .wf-bar:nth-child(2) { animation-delay: 120ms; }
.wf.active .wf-bar:nth-child(3) { animation-delay: 240ms; }
.wf.active .wf-bar:nth-child(4) { animation-delay: 160ms; }
.wf.active .wf-bar:nth-child(5) { animation-delay: 80ms; }

@keyframes wfd {
  0% { transform: scaleY(0.25); }
  100% { transform: scaleY(1); }
}

/* container positioning */
.widget-anchor {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* ── "Translate my voice" button (What they hear) ── */
.action-btn.mic-start {
  background: linear-gradient(160deg, var(--glass-3) 0%, var(--glass-1) 100%);
  color: #d49cf7;
  border: 1px solid rgba(191, 90, 242, 0.35);
  padding: 10px 14px;
  font-size: 12.5px;
}

.action-btn.mic-start:hover {
  background: rgba(191, 90, 242, 0.16);
  border-color: #bf5af2;
}

.action-btn.mic-stop {
  background: #bf5af2;
  color: #ffffff;
  border: 1px solid #bf5af2;
  box-shadow: none;
  padding: 10px 14px;
  font-size: 12.5px;
}

.action-btn.mic-stop:hover { opacity: 0.92; }
.action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Voice status line */
.p-mic-status {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 10.5px;
  color: var(--text2);
  font-weight: 500;
  line-height: 1.35;
}

.p-mic-status .s-dot { margin-top: 3px; flex: none; }
.p-mic-status:empty, .p-mic-status.hidden { display: none; }

.t-lang {
  display: inline-block;
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid var(--glass-border);
  font-family: "JetBrains Mono", monospace;
  font-size: 8.5px;
  letter-spacing: 0.4px;
  color: var(--text2);
}

/* Transcript source label */
.t-source {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--amber);
  margin-bottom: 2px;
}

.t-source.incoming {
  color: var(--green);
}

/* ── Notes button + flash line ── */
.action-btn.notes {
  background: transparent;
  color: var(--text2);
  border: 1px solid var(--glass-border);
  box-shadow: none;
  padding: 10px 14px;
  font-size: 12.5px;
}

.action-btn.notes:hover {
  color: var(--text);
  background: var(--glass-2);
}

.action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.p-flash {
  margin: 6px 12px 0;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.4;
  background: var(--amber-dim);
  color: var(--amber);
}

.p-flash.error {
  background: var(--red-dim);
  color: var(--red);
}

.p-flash[hidden] { display: none; }

.t-source.me { color: var(--amber); }
.t-partial .t-orig { opacity: 0.75; }
`,y='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',H='<svg viewBox="0 0 32 20" fill="currentColor" class="wf"><rect class="wf-bar" x="3" y="6" width="3" height="8" rx="1.5"/><rect class="wf-bar" x="8.5" y="3" width="3" height="14" rx="1.5"/><rect class="wf-bar" x="14" y="1" width="3" height="18" rx="1.5"/><rect class="wf-bar" x="19.5" y="4" width="3" height="12" rx="1.5"/><rect class="wf-bar" x="25" y="6.5" width="3" height="7" rx="1.5"/></svg>',A='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/></svg>',D='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>',N='<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',I='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',w='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>',O='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';class V{constructor(){i(this,"host");i(this,"shadow");i(this,"anchor");i(this,"fab");i(this,"panel");i(this,"expanded",!1);i(this,"state",{...E});i(this,"modes",{translate:!0,notes:!0});i(this,"myLang","en");i(this,"sourceLang",h);i(this,"speakLang",h);i(this,"entries",[]);i(this,"partials",{});i(this,"entryCounter",0);i(this,"outgoingError","");i(this,"flashTimer",null);i(this,"fabDot");i(this,"statusDot");i(this,"statusLabel");i(this,"flashEl");i(this,"waveformEl");i(this,"myLangSelect");i(this,"sourceSelect");i(this,"speakSelect");i(this,"micHint");i(this,"micStatusRow");i(this,"actionBtn");i(this,"micActionBtn");i(this,"notesBtn");i(this,"micStatusDot");i(this,"micStatusLabel");i(this,"transcriptBox");i(this,"onRuntimeMessage",t=>{t&&typeof t=="object"&&t.target==="ui"&&this.handleUiMessage(t)});i(this,"onStorageChanged",(t,e)=>{var l;if(e!=="sync")return;const a=(l=t.modes)==null?void 0:l.newValue;a&&typeof a.translate=="boolean"&&(this.modes=a);const n=d=>{var p;return typeof((p=t[d])==null?void 0:p.newValue)=="string"?t[d].newValue:null},r=n("targetLang");r&&(this.myLang=r,this.myLangSelect.value=r,this.fillSpeakOptions());const s=n("sourceLang");s&&(this.sourceLang=this.sourceSelect.value=s);const o=n("speakLang");o&&(this.speakLang=o,this.speakSelect.value=o),(a||r||s||o)&&this.render()});this.host=document.createElement("div"),this.host.id="interpreter-meet-widget-host",this.shadow=this.host.attachShadow({mode:"closed"});const t=document.createElement("style");t.textContent=$,this.shadow.appendChild(t),this.buildDOM(),document.body.appendChild(this.host),this.loadSettings(),chrome.runtime.onMessage.addListener(this.onRuntimeMessage),chrome.storage.onChanged.addListener(this.onStorageChanged),this.syncState()}buildDOM(){this.anchor=this.el("div","widget-anchor"),this.buildFab(),this.buildPanel(),this.anchor.appendChild(this.fab),this.shadow.appendChild(this.anchor)}buildFab(){this.fab=this.el("div","fab"),this.fab.innerHTML=y,this.fabDot=this.el("div","fab-dot"),this.fab.appendChild(this.fabDot),this.fab.addEventListener("click",()=>this.toggleExpand())}buildPanel(){this.panel=this.el("div","panel");const t=this.el("div","p-header"),e=this.el("div","p-logo");e.innerHTML=y;const a=this.el("div","p-title-wrap"),n=this.el("span","p-title");n.textContent="Distill";const r=this.el("div","p-subtitle");r.textContent="Translate · Notes",a.append(n,r),this.waveformEl=this.el("div","p-waveform"),this.waveformEl.innerHTML=H;const s=this.el("button","p-minimize");s.innerHTML=I,s.addEventListener("click",()=>this.toggleExpand()),t.append(e,a,this.waveformEl,s);const o=this.el("div","p-status");this.statusDot=this.el("div","s-dot"),this.statusLabel=this.el("span"),this.statusLabel.textContent="Ready",o.append(this.statusDot,this.statusLabel),this.flashEl=this.el("div","p-flash"),this.flashEl.hidden=!0,this.micStatusRow=this.el("div","p-mic-status"),this.micStatusDot=this.el("div","s-dot"),this.micStatusLabel=this.el("span"),this.micStatusRow.append(this.micStatusDot,this.micStatusLabel);const l=this.el("div","p-body"),d=this.el("label","w-field"),p=this.el("span","w-label");p.textContent="My language — I speak & hear",this.myLangSelect=this.buildSelect([],this.myLang),this.myLangSelect.title="The language you speak and want to hear",this.myLangSelect.addEventListener("change",()=>{this.myLang=this.myLangSelect.value,chrome.storage.sync.set({targetLang:this.myLang}),this.fillSpeakOptions(),this.render()}),d.append(p,this.wrap(this.myLangSelect));const b=this.el("div","w-group hear"),f=this.el("span","w-label");f.innerHTML=`${A}<span>What I hear · they speak</span>`,this.sourceSelect=this.buildSelect([[h,"Auto-detect (any language)"]],this.sourceLang),this.sourceSelect.title="The language the others speak — Auto-detect handles several languages",this.sourceSelect.addEventListener("change",()=>{this.sourceLang=this.sourceSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang})}),this.actionBtn=this.el("button","action-btn start"),this.actionBtn.addEventListener("click",()=>this.toggleCapture()),b.append(f,this.wrap(this.sourceSelect),this.actionBtn);const m=this.el("div","w-group speak"),x=this.el("span","w-label");x.innerHTML=`${w}<span>What they hear · others hear me in</span>`,this.speakSelect=this.buildSelect([[h,"Auto — match the room"]],this.speakLang),this.speakSelect.title="Everyone in the call hears your voice in this one language",this.speakSelect.addEventListener("change",()=>{this.speakLang=this.speakSelect.value,chrome.storage.sync.set({speakLang:this.speakLang}),this.state.isMicTranslating&&this.send({type:"set-speak-language",target:"background",speakLang:this.speakLang})}),this.micActionBtn=this.el("button","action-btn mic-start"),this.micActionBtn.addEventListener("click",()=>this.toggleMicTranslation()),this.micHint=this.el("div","w-hint"),this.micHint.textContent="Use headphones. If the others run Distill too, leave this off — they hear you in their own language.",m.append(x,this.wrap(this.speakSelect),this.micActionBtn,this.micStatusRow,this.micHint),this.notesBtn=this.el("button","action-btn notes"),this.notesBtn.innerHTML=`${O}<span>Open notes panel</span>`,this.notesBtn.addEventListener("click",()=>this.openNotesPanel()),this.transcriptBox=this.el("div","transcript"),l.append(d,b,m,this.notesBtn,this.transcriptBox),this.panel.append(t,o,this.flashEl,l),this.render()}buildSelect(t,e,a){const n=document.createElement("select");return this.fillSelect(n,t,e,a),n}fillSelect(t,e,a,n){t.textContent="";const r=[...e,...T.filter(s=>s.code!==n).map(s=>[s.code,s.name])];for(const[s,o]of r){const l=document.createElement("option");l.value=s,l.textContent=o,t.appendChild(l)}t.value=r.some(([s])=>s===a)?a:r[0][0]}fillSpeakOptions(){this.fillSelect(this.speakSelect,[[h,"Auto — match the room"]],this.speakLang,this.myLang),this.speakSelect.value!==this.speakLang&&(this.speakLang=this.speakSelect.value,chrome.storage.sync.set({speakLang:this.speakLang}))}wrap(t){const e=this.el("div","langs");return e.appendChild(t),e}toggleExpand(){this.expanded=!this.expanded,this.expanded?(this.fab.remove(),this.anchor.appendChild(this.panel)):(this.panel.remove(),this.anchor.appendChild(this.fab))}send(t,e){try{chrome.runtime.sendMessage(t,a=>{const n=chrome.runtime.lastError;!n&&(a!=null&&a.state)&&(this.state=a.state,this.render()),e&&e(n?{success:!1,error:n.message}:a)})}catch{this.flash("Distill was updated — reload this Meet tab.",!0)}}friendlyError(t){return/invoked|activeTab|permission|Chrome pages/i.test(t)?`${t} — click the Distill toolbar icon on this tab and press Start there.`:t}toggleCapture(){if(this.state.isCapturing){this.send({type:"stop-capture",target:"background",endMeeting:!0},()=>this.syncState());return}this.sourceLang=this.sourceSelect.value,this.myLang=this.myLangSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang,targetLang:this.myLang}),chrome.storage.sync.get(["modes","includeMic","sttProvider","ttsProvider","originalAudio"],t=>{const e=t.modes&&typeof t.modes.translate=="boolean"?t.modes:this.modes;this.entries=[],this.partials={},this.renderTranscript(),this.send({type:"start-capture",target:"background",sourceLang:this.sourceLang,targetLang:this.myLang,modes:e,includeMic:t.includeMic!==!1&&e.notes,sttProvider:t.sttProvider||null,ttsProvider:e.translate&&t.ttsProvider||null,originalAudio:t.originalAudio==="quiet"?"quiet":"muted"},a=>{a&&a.success===!1&&(this.flash(this.friendlyError(a.error||"Failed to start capture"),!0),this.syncState())})})}toggleMicTranslation(){if(this.state.isMicTranslating){this.send({type:"stop-mic-translation",target:"background"},()=>this.syncState());return}this.outgoingError="",this.myLang=this.myLangSelect.value,this.speakLang=this.speakSelect.value,this.send({type:"start-mic-translation",target:"background",myLang:this.myLang,speakLang:this.speakLang,roomHint:this.sourceSelect.value},t=>{t&&t.success===!1&&(this.outgoingError=t.error||"Failed to start voice translation",this.render(),this.syncState())})}openNotesPanel(){this.send({type:"open-side-panel",target:"background"},t=>{t&&t.success===!1&&this.flash("Click the Distill toolbar icon → Open notes panel.",!1)})}handleUiMessage(t){switch(t.type){case"state":this.state=t.state,this.render();return;case"transcript":{t.isFinal?(this.partials[t.source]=void 0,(!t.segmentId||!this.entries.some(e=>e.segmentId===t.segmentId))&&(this.entries.push({key:++this.entryCounter,source:t.source,speaker:t.speaker,orig:t.text,trans:"",lang:t.language,segmentId:t.segmentId}),this.entries=this.entries.slice(-6*3))):this.partials[t.source]={speaker:t.speaker,text:t.text},this.renderTranscript();return}case"translation":{if(t.isFinal){let e=t.segmentId?this.entries.find(a=>a.segmentId===t.segmentId):void 0;if(!e){for(let a=this.entries.length-1;a>=0;a--)if(this.entries[a].source===t.source&&!this.entries[a].trans){e=this.entries[a];break}}e?e.trans=t.text:this.entries.push({key:++this.entryCounter,source:t.source,speaker:t.speaker,orig:"",trans:t.text})}else{const e=this.partials[t.source];e&&(e.translation=t.text)}this.renderTranscript();return}case"error":t.channel==="outgoing"?(this.outgoingError=t.message,this.render()):this.flash(this.friendlyError(t.message),!0);return;case"warning":this.flash(t.message,!1);return;case"meeting-ended":this.flash("Meeting saved — open the notes panel for the summary.",!1);return}}flash(t,e){this.flashEl.textContent=t,this.flashEl.className=`p-flash${e?" error":""}`,this.flashEl.hidden=!1,this.flashTimer&&clearTimeout(this.flashTimer),this.flashTimer=setTimeout(()=>this.flashEl.hidden=!0,e?1e4:6e3)}render(){var d;const t=this.state,e=t.status==="capturing"?"capturing":t.status==="error"?"error":t.status==="connecting"||t.status==="reconnecting"?"connected":"idle";this.fabDot.className=`fab-dot ${e}`,this.statusDot.className=`s-dot ${e}`;const a=t.isCapturing?t.modes:this.modes,n=a.translate&&a.notes?"translation + notes":a.translate?"translation":"notes";this.statusLabel.textContent=t.status==="connecting"?"Connecting…":t.status==="reconnecting"?"Reconnecting…":t.status==="capturing"?a.translate&&a.notes?"Translating & taking notes":a.translate?"Translating live":"Taking notes":t.status==="error"?t.lastError||"Error":"Ready",this.waveformEl.className=`p-waveform${t.isCapturing?" active":""}`,(d=this.waveformEl.querySelector(".wf"))==null||d.classList.toggle("active",t.isCapturing);const r=t.isCapturing||t.status==="connecting";this.myLangSelect.disabled=r||t.isMicTranslating,this.sourceSelect.disabled=r,t.isCapturing?(this.actionBtn.className="action-btn stop",this.actionBtn.innerHTML=`${N}<span>${t.modes.notes?"Stop & summarize":"Stop"}</span>`,this.actionBtn.disabled=!1):(this.actionBtn.className="action-btn start",this.actionBtn.innerHTML=`${D}<span>${t.status==="connecting"?"Starting…":a.translate?`Hear everyone in ${this.esc(u(this.myLang))}`:`Start ${n}`}</span>`,this.actionBtn.disabled=t.status==="connecting");const s=t.outgoingStatus;let o=this.outgoingError;s==="starting"?o="Connecting your voice…":s==="error"?o=this.outgoingError||"Voice translation failed":s==="on"&&(o=t.outgoingLang?`Others hear you in ${u(t.outgoingLang)}`:t.speakLang===h&&!t.isCapturing?"Not translating — others hear your own voice. Pick a language above, or start “What I hear” so Distill learns the room's language.":t.speakLang===h?`Not translating yet — others hear your own voice until the room has spoken another language than ${u(this.myLang)}. Pick a language above to translate right away.`:"Not translating — others hear your own voice");const l=s==="on"?t.outgoingLang?" capturing":" waiting":s==="starting"?" connected":s==="error"?" error":"";this.micStatusDot.className=`s-dot${l}`,this.micStatusLabel.textContent=o,this.micStatusRow.classList.toggle("hidden",!o),this.micHint.hidden=t.isMicTranslating,this.micActionBtn.className=t.isMicTranslating?"action-btn mic-stop":"action-btn mic-start",this.micActionBtn.innerHTML=`${w}<span>${t.isMicTranslating?"Stop — others hear my own voice":"Translate my voice"}</span>`,this.micActionBtn.title="Speak your language; everyone in the call hears the language chosen above.",this.renderTranscript()}renderTranscript(){const t=this.transcriptBox,e=Object.entries(this.partials).filter(r=>{var s;return!!((s=r[1])!=null&&s.text)});if(this.entries.length===0&&e.length===0){t.innerHTML=`<div class="t-empty">${this.state.isCapturing?"Listening…":"Live transcript and translations appear here"}</div>`;return}const a=(r,s)=>r==="mic"?"me":s;let n="";for(const r of this.entries.slice(-6)){const s=a(r.source,r.speaker),o=r.lang&&!C(r.lang,this.myLang)?`<span class="t-lang">${this.esc(B(r.lang))}</span>`:"";n+=`<div class="t-entry"><div class="t-source ${s==="me"?"me":"incoming"}">${this.esc(v(s))}${o}</div>`,r.orig&&(n+=`<div class="t-orig">${this.esc(r.orig)}</div>`),r.trans&&(n+=`<div class="t-trans">${this.esc(r.trans)}</div>`),n+="</div>"}for(const[r,s]of e){const o=a(r,s.speaker);n+=`<div class="t-entry t-partial"><div class="t-source ${o==="me"?"me":"incoming"}">${this.esc(v(o))}</div><div class="t-orig">${this.esc(s.text)}</div>`,s.translation&&(n+=`<div class="t-trans">${this.esc(s.translation)}</div>`),n+="</div>"}t.innerHTML=n,t.scrollTop=t.scrollHeight}syncState(){this.send({type:"get-state",target:"background"},t=>{const e=t==null?void 0:t.state;e&&(this.state=e,this.render())})}loadSettings(){chrome.storage.sync.get(["sourceLang","targetLang","speakLang","modes"],t=>{typeof t.targetLang=="string"&&(this.myLang=this.myLangSelect.value=t.targetLang),typeof t.sourceLang=="string"&&(this.sourceLang=this.sourceSelect.value=t.sourceLang),typeof t.speakLang=="string"?this.speakLang=t.speakLang:typeof t.sourceLang=="string"&&t.sourceLang!==h&&(this.speakLang=t.sourceLang),this.fillSpeakOptions(),t.modes&&typeof t.modes.translate=="boolean"&&(this.modes=t.modes),this.render()})}el(t,e){const a=document.createElement(t);return e&&(a.className=e),a}esc(t){const e=document.createElement("div");return e.textContent=t,e.innerHTML}destroy(){chrome.runtime.onMessage.removeListener(this.onRuntimeMessage),chrome.storage.onChanged.removeListener(this.onStorageChanged),this.flashTimer&&clearTimeout(this.flashTimer),this.host.remove()}}let g=null;function L(){const c=z.test(window.location.pathname);c&&!g?g=new V:!c&&g&&(g.destroy(),g=null)}L();let k=location.href;const P=new MutationObserver(()=>{location.href!==k&&(k=location.href,L())});P.observe(document.body,{childList:!0,subtree:!0});
