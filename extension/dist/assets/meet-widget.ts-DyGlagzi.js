var m=Object.defineProperty;var x=(o,t,e)=>t in o?m(o,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):o[t]=e;var a=(o,t,e)=>x(o,typeof t!="symbol"?t+"":t,e);import{L as v}from"./languages-l3NF9G8N.js";import{I as w,s as g}from"./protocol-YEH95tgC.js";const k=/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i,y=`
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

.swap-btn {
  width: 28px;
  height: 28px;
  background: var(--glass-2);
  border: 1px solid var(--glass-border);
  border-radius: 50%;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.25s;
}

.swap-btn svg { width: 12px; height: 12px; transition: transform 0.3s; }

.swap-btn:hover {
  color: var(--text2);
  background: var(--glass-3);
  border-color: rgba(255,255,255,0.22);
}

.swap-btn:hover svg { transform: rotate(180deg); }
.swap-btn:disabled { opacity: 0.3; cursor: not-allowed; }

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

/* ── Mic Translation Button ── */
.action-btn.mic-start {
  background: linear-gradient(160deg, var(--glass-3) 0%, var(--glass-1) 100%);
  color: var(--amber);
  border: 1px solid rgba(255, 159, 10, 0.18);
  margin-top: 6px;
}

.action-btn.mic-start:hover {
  background: var(--amber-dim);
  border-color: var(--amber);
}

.action-btn.mic-stop {
  background: var(--amber-dim);
  color: var(--amber);
  border: 1px solid var(--amber);
  margin-top: 6px;
  box-shadow: none;
}

.action-btn.mic-stop:hover {
  background: rgba(255, 159, 10, 0.20);
}

/* Mic status row */
.p-mic-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 16px 0;
  font-size: 10px;
  color: var(--text2);
  font-weight: 500;
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
`,u='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',L='<svg viewBox="0 0 32 20" fill="currentColor" class="wf"><rect class="wf-bar" x="3" y="6" width="3" height="8" rx="1.5"/><rect class="wf-bar" x="8.5" y="3" width="3" height="14" rx="1.5"/><rect class="wf-bar" x="14" y="1" width="3" height="18" rx="1.5"/><rect class="wf-bar" x="19.5" y="4" width="3" height="12" rx="1.5"/><rect class="wf-bar" x="25" y="6.5" width="3" height="7" rx="1.5"/></svg>',S='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16l-4-4 4-4"/><path d="M17 8l4 4-4 4"/><path d="M3 12h18"/></svg>',M='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>',E='<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',C='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',T='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>',B='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';class z{constructor(){a(this,"host");a(this,"shadow");a(this,"anchor");a(this,"fab");a(this,"panel");a(this,"expanded",!1);a(this,"state",{...w});a(this,"modes",{translate:!0,notes:!0});a(this,"sourceLang","en");a(this,"targetLang","es");a(this,"entries",[]);a(this,"partials",{});a(this,"entryCounter",0);a(this,"outgoingError","");a(this,"flashTimer",null);a(this,"fabDot");a(this,"statusDot");a(this,"statusLabel");a(this,"flashEl");a(this,"waveformEl");a(this,"sourceSelect");a(this,"targetSelect");a(this,"swapBtn");a(this,"actionBtn");a(this,"micActionBtn");a(this,"notesBtn");a(this,"micStatusDot");a(this,"micStatusLabel");a(this,"transcriptBox");a(this,"onRuntimeMessage",t=>{t&&typeof t=="object"&&t.target==="ui"&&this.handleUiMessage(t)});a(this,"onStorageChanged",(t,e)=>{if(e!=="sync"||!t.modes)return;const s=t.modes.newValue;s&&typeof s.translate=="boolean"&&(this.modes=s,this.render())});this.host=document.createElement("div"),this.host.id="interpreter-meet-widget-host",this.shadow=this.host.attachShadow({mode:"closed"});const t=document.createElement("style");t.textContent=y,this.shadow.appendChild(t),this.buildDOM(),document.body.appendChild(this.host),this.loadSettings(),chrome.runtime.onMessage.addListener(this.onRuntimeMessage),chrome.storage.onChanged.addListener(this.onStorageChanged),this.syncState()}buildDOM(){this.anchor=this.el("div","widget-anchor"),this.buildFab(),this.buildPanel(),this.anchor.appendChild(this.fab),this.shadow.appendChild(this.anchor)}buildFab(){this.fab=this.el("div","fab"),this.fab.innerHTML=u,this.fabDot=this.el("div","fab-dot"),this.fab.appendChild(this.fabDot),this.fab.addEventListener("click",()=>this.toggleExpand())}buildPanel(){this.panel=this.el("div","panel");const t=this.el("div","p-header"),e=this.el("div","p-logo");e.innerHTML=u;const s=this.el("div","p-title-wrap"),i=this.el("span","p-title");i.textContent="Distill";const n=this.el("div","p-subtitle");n.textContent="Translate · Notes",s.append(i,n),this.waveformEl=this.el("div","p-waveform"),this.waveformEl.innerHTML=L;const r=this.el("button","p-minimize");r.innerHTML=C,r.addEventListener("click",()=>this.toggleExpand()),t.append(e,s,this.waveformEl,r);const l=this.el("div","p-status");this.statusDot=this.el("div","s-dot"),this.statusLabel=this.el("span"),this.statusLabel.textContent="Ready",l.append(this.statusDot,this.statusLabel),this.flashEl=this.el("div","p-flash"),this.flashEl.hidden=!0;const d=this.el("div","p-mic-status");this.micStatusDot=this.el("div","s-dot"),this.micStatusLabel=this.el("span"),d.append(this.micStatusDot,this.micStatusLabel);const h=this.el("div","p-body"),p=this.el("div","langs");this.sourceSelect=this.buildLangSelect(this.sourceLang),this.targetSelect=this.buildLangSelect(this.targetLang),this.sourceSelect.title="Language spoken in the meeting",this.targetSelect.title="Your language",this.swapBtn=this.el("button","swap-btn"),this.swapBtn.innerHTML=S,this.swapBtn.addEventListener("click",()=>this.swapLangs()),p.append(this.sourceSelect,this.swapBtn,this.targetSelect),this.actionBtn=this.el("button","action-btn start"),this.actionBtn.addEventListener("click",()=>this.toggleCapture()),this.micActionBtn=this.el("button","action-btn mic-start"),this.micActionBtn.addEventListener("click",()=>this.toggleMicTranslation()),this.notesBtn=this.el("button","action-btn notes"),this.notesBtn.innerHTML=`${B}<span>Open notes panel</span>`,this.notesBtn.addEventListener("click",()=>this.openNotesPanel()),this.transcriptBox=this.el("div","transcript"),h.append(p,this.actionBtn,this.micActionBtn,this.notesBtn,this.transcriptBox),this.panel.append(t,l,this.flashEl,d,h),this.render()}buildLangSelect(t){const e=document.createElement("select");for(const s of v){const i=document.createElement("option");i.value=s.code,i.textContent=s.name,s.code===t&&(i.selected=!0),e.appendChild(i)}return e.addEventListener("change",()=>{this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang,targetLang:this.targetLang})}),e}toggleExpand(){this.expanded=!this.expanded,this.expanded?(this.fab.remove(),this.anchor.appendChild(this.panel)):(this.panel.remove(),this.anchor.appendChild(this.fab))}swapLangs(){const t=this.sourceSelect.value;this.sourceSelect.value=this.targetSelect.value,this.targetSelect.value=t,this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang,targetLang:this.targetLang})}send(t,e){try{chrome.runtime.sendMessage(t,s=>{const i=chrome.runtime.lastError;!i&&(s!=null&&s.state)&&(this.state=s.state,this.render()),e&&e(i?{success:!1,error:i.message}:s)})}catch{this.flash("Distill was updated — reload this Meet tab.",!0)}}friendlyError(t){return/invoked|activeTab|permission|Chrome pages/i.test(t)?`${t} — click the Distill toolbar icon on this tab and press Start there.`:t}toggleCapture(){if(this.state.isCapturing){this.send({type:"stop-capture",target:"background",endMeeting:!0},()=>this.syncState());return}this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang,targetLang:this.targetLang}),chrome.storage.sync.get(["modes","includeMic","sttProvider","ttsProvider"],t=>{const e=t.modes&&typeof t.modes.translate=="boolean"?t.modes:this.modes;this.entries=[],this.partials={},this.renderTranscript(),this.send({type:"start-capture",target:"background",sourceLang:this.sourceLang,targetLang:this.targetLang,modes:e,includeMic:t.includeMic!==!1&&e.notes,sttProvider:t.sttProvider||null,ttsProvider:e.translate&&t.ttsProvider||null},s=>{s&&s.success===!1&&(this.flash(this.friendlyError(s.error||"Failed to start capture"),!0),this.syncState())})})}toggleMicTranslation(){if(this.state.isMicTranslating){this.send({type:"stop-mic-translation",target:"background"},()=>this.syncState());return}this.outgoingError="",this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,this.send({type:"start-mic-translation",target:"background",sourceLang:this.sourceLang,targetLang:this.targetLang},t=>{t&&t.success===!1&&(this.outgoingError=t.error||"Failed to start voice translation",this.render(),this.syncState())})}openNotesPanel(){this.send({type:"open-side-panel",target:"background"},t=>{t&&t.success===!1&&this.flash("Click the Distill toolbar icon → Open notes panel.",!1)})}handleUiMessage(t){switch(t.type){case"state":this.state=t.state,this.render();return;case"transcript":{t.isFinal?(this.partials[t.source]=void 0,(!t.segmentId||!this.entries.some(e=>e.segmentId===t.segmentId))&&(this.entries.push({key:++this.entryCounter,source:t.source,speaker:t.speaker,orig:t.text,trans:"",segmentId:t.segmentId}),this.entries=this.entries.slice(-6*3))):this.partials[t.source]={speaker:t.speaker,text:t.text},this.renderTranscript();return}case"translation":{if(t.isFinal){let e=t.segmentId?this.entries.find(s=>s.segmentId===t.segmentId):void 0;if(!e){for(let s=this.entries.length-1;s>=0;s--)if(this.entries[s].source===t.source&&!this.entries[s].trans){e=this.entries[s];break}}e?e.trans=t.text:this.entries.push({key:++this.entryCounter,source:t.source,speaker:t.speaker,orig:"",trans:t.text})}else{const e=this.partials[t.source];e&&(e.translation=t.text)}this.renderTranscript();return}case"error":t.channel==="outgoing"?(this.outgoingError=t.message,this.render()):this.flash(this.friendlyError(t.message),!0);return;case"warning":this.flash(t.message,!1);return;case"meeting-ended":this.flash("Meeting saved — open the notes panel for the summary.",!1);return}}flash(t,e){this.flashEl.textContent=t,this.flashEl.className=`p-flash${e?" error":""}`,this.flashEl.hidden=!1,this.flashTimer&&clearTimeout(this.flashTimer),this.flashTimer=setTimeout(()=>this.flashEl.hidden=!0,e?1e4:6e3)}render(){var l;const t=this.state,e=t.status==="capturing"?"capturing":t.status==="error"?"error":t.status==="connecting"||t.status==="reconnecting"?"connected":"idle";this.fabDot.className=`fab-dot ${e}`,this.statusDot.className=`s-dot ${e}`;const s=t.isCapturing?t.modes:this.modes,i=s.translate&&s.notes?"translation + notes":s.translate?"translation":"notes";this.statusLabel.textContent=t.status==="connecting"?"Connecting…":t.status==="reconnecting"?"Reconnecting…":t.status==="capturing"?s.translate&&s.notes?"Translating & taking notes":s.translate?"Translating live":"Taking notes":t.status==="error"?t.lastError||"Error":"Ready",this.waveformEl.className=`p-waveform${t.isCapturing?" active":""}`,(l=this.waveformEl.querySelector(".wf"))==null||l.classList.toggle("active",t.isCapturing);const n=t.isCapturing||t.isMicTranslating||t.status==="connecting";this.sourceSelect.disabled=n,this.targetSelect.disabled=n,this.swapBtn.disabled=n,t.isCapturing?(this.actionBtn.className="action-btn stop",this.actionBtn.innerHTML=`${E}<span>${t.modes.notes?"Stop & summarize":"Stop"}</span>`,this.actionBtn.disabled=!1):(this.actionBtn.className="action-btn start",this.actionBtn.innerHTML=`${M}<span>${t.status==="connecting"?"Starting…":`Start ${i}`}</span>`,this.actionBtn.disabled=t.status==="connecting");const r=t.outgoingStatus;this.micStatusDot.className=`s-dot${r==="on"?" capturing":r==="starting"?" connected":r==="error"?" error":""}`,this.micStatusLabel.textContent=r==="on"?"Others hear you translated":r==="starting"?"Connecting your voice…":r==="error"?this.outgoingError||"Voice translation failed":this.outgoingError,this.micActionBtn.className=t.isMicTranslating?"action-btn mic-stop":"action-btn mic-start",this.micActionBtn.innerHTML=`${T}<span>${t.isMicTranslating?"Stop translating my voice":"Translate my voice"}</span>`,this.micActionBtn.title="Speak in your language; other participants hear the meeting language.",this.renderTranscript()}renderTranscript(){const t=this.transcriptBox,e=Object.entries(this.partials).filter(n=>{var r;return!!((r=n[1])!=null&&r.text)});if(this.entries.length===0&&e.length===0){t.innerHTML=`<div class="t-empty">${this.state.isCapturing?"Listening…":"Live transcript and translations appear here"}</div>`;return}const s=(n,r)=>n==="mic"?"me":r;let i="";for(const n of this.entries.slice(-6)){const r=s(n.source,n.speaker);i+=`<div class="t-entry"><div class="t-source ${r==="me"?"me":"incoming"}">${this.esc(g(r))}</div>`,n.orig&&(i+=`<div class="t-orig">${this.esc(n.orig)}</div>`),n.trans&&(i+=`<div class="t-trans">${this.esc(n.trans)}</div>`),i+="</div>"}for(const[n,r]of e){const l=s(n,r.speaker);i+=`<div class="t-entry t-partial"><div class="t-source ${l==="me"?"me":"incoming"}">${this.esc(g(l))}</div><div class="t-orig">${this.esc(r.text)}</div>`,r.translation&&(i+=`<div class="t-trans">${this.esc(r.translation)}</div>`),i+="</div>"}t.innerHTML=i,t.scrollTop=t.scrollHeight}syncState(){this.send({type:"get-state",target:"background"},t=>{const e=t==null?void 0:t.state;e&&(this.state=e,this.render())})}loadSettings(){chrome.storage.sync.get(["sourceLang","targetLang","modes"],t=>{t.sourceLang&&(this.sourceLang=t.sourceLang,this.sourceSelect.value=t.sourceLang),t.targetLang&&(this.targetLang=t.targetLang,this.targetSelect.value=t.targetLang),t.modes&&typeof t.modes.translate=="boolean"&&(this.modes=t.modes),this.render()})}el(t,e){const s=document.createElement(t);return e&&(s.className=e),s}esc(t){const e=document.createElement("div");return e.textContent=t,e.innerHTML}destroy(){chrome.runtime.onMessage.removeListener(this.onRuntimeMessage),chrome.storage.onChanged.removeListener(this.onStorageChanged),this.flashTimer&&clearTimeout(this.flashTimer),this.host.remove()}}let c=null;function f(){const o=k.test(window.location.pathname);o&&!c?c=new z:!o&&c&&(c.destroy(),c=null)}f();let b=location.href;const $=new MutationObserver(()=>{location.href!==b&&(b=location.href,f())});$.observe(document.body,{childList:!0,subtree:!0});
