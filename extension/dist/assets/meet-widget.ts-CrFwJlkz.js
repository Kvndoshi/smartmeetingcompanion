var f=Object.defineProperty;var v=(s,t,r)=>t in s?f(s,t,{enumerable:!0,configurable:!0,writable:!0,value:r}):s[t]=r;var e=(s,t,r)=>v(s,typeof t!="symbol"?t+"":t,r);import{L as w}from"./languages-l3NF9G8N.js";const k=/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i,y={idle:"Ready",connected:"Connected",capturing:"Translating live",disconnected:"Disconnected",error:"Error"},L=`
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
`,u='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',S='<svg viewBox="0 0 32 20" fill="currentColor" class="wf"><rect class="wf-bar" x="3" y="6" width="3" height="8" rx="1.5"/><rect class="wf-bar" x="8.5" y="3" width="3" height="14" rx="1.5"/><rect class="wf-bar" x="14" y="1" width="3" height="18" rx="1.5"/><rect class="wf-bar" x="19.5" y="4" width="3" height="12" rx="1.5"/><rect class="wf-bar" x="25" y="6.5" width="3" height="7" rx="1.5"/></svg>',T='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16l-4-4 4-4"/><path d="M17 8l4 4-4 4"/><path d="M3 12h18"/></svg>',b='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>',M='<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',C='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',d='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';class B{constructor(){e(this,"host");e(this,"shadow");e(this,"anchor");e(this,"fab");e(this,"panel");e(this,"expanded",!1);e(this,"status","idle");e(this,"isCapturing",!1);e(this,"sourceLang","en");e(this,"targetLang","es");e(this,"transcripts",[]);e(this,"currentOrig","");e(this,"currentTrans","");e(this,"isMicTranslating",!1);e(this,"micActionBtn");e(this,"micStatusDot");e(this,"micStatusLabel");e(this,"micTranscripts",[]);e(this,"micCurrentOrig","");e(this,"micCurrentTrans","");e(this,"fabDot");e(this,"statusDot");e(this,"statusLabel");e(this,"waveformEl");e(this,"sourceSelect");e(this,"targetSelect");e(this,"swapBtn");e(this,"actionBtn");e(this,"transcriptBox");this.host=document.createElement("div"),this.host.id="interpreter-meet-widget-host",this.shadow=this.host.attachShadow({mode:"closed"});const t=document.createElement("style");t.textContent=L,this.shadow.appendChild(t),this.buildDOM(),document.body.appendChild(this.host),this.loadSettings(),this.listenForMessages(),this.syncState()}buildDOM(){this.anchor=this.el("div","widget-anchor"),this.buildFab(),this.buildPanel(),this.anchor.appendChild(this.fab),this.shadow.appendChild(this.anchor)}buildFab(){this.fab=this.el("div","fab"),this.fab.innerHTML=u,this.fabDot=this.el("div","fab-dot"),this.fab.appendChild(this.fabDot),this.fab.addEventListener("click",()=>this.toggleExpand())}buildPanel(){this.panel=this.el("div","panel");const t=this.el("div","p-header"),r=this.el("div","p-logo");r.innerHTML=u;const i=this.el("div","p-title-wrap"),a=this.el("span","p-title");a.textContent="Distill";const l=this.el("div","p-subtitle");l.textContent="Live Translation",i.append(a,l),this.waveformEl=this.el("div","p-waveform"),this.waveformEl.innerHTML=S;const o=this.el("button","p-minimize");o.innerHTML=C,o.addEventListener("click",()=>this.toggleExpand()),t.append(r,i,this.waveformEl,o);const n=this.el("div","p-status");this.statusDot=this.el("div","s-dot"),this.statusLabel=this.el("span"),this.statusLabel.textContent="Ready",n.append(this.statusDot,this.statusLabel);const p=this.el("div","p-body"),g=this.el("div","langs");this.sourceSelect=this.buildLangSelect(this.sourceLang),this.targetSelect=this.buildLangSelect(this.targetLang),this.swapBtn=this.el("button","swap-btn"),this.swapBtn.innerHTML=T,this.swapBtn.addEventListener("click",()=>this.swapLangs()),g.append(this.sourceSelect,this.swapBtn,this.targetSelect),this.actionBtn=this.el("button","action-btn start"),this.actionBtn.innerHTML=`${b}<span>Start Translation</span>`,this.actionBtn.addEventListener("click",()=>this.toggleCapture()),this.micActionBtn=this.el("button","action-btn mic-start"),this.micActionBtn.innerHTML=`${d}<span>Translate My Voice</span>`,this.micActionBtn.addEventListener("click",()=>this.toggleMicTranslation()),this.transcriptBox=this.el("div","transcript"),this.transcriptBox.innerHTML='<div class="t-empty">Translations will appear here</div>';const h=this.el("div","p-mic-status");this.micStatusDot=this.el("div","s-dot"),this.micStatusLabel=this.el("span"),this.micStatusLabel.textContent="",h.append(this.micStatusDot,this.micStatusLabel),p.append(g,this.actionBtn,this.micActionBtn,this.transcriptBox),this.panel.append(t,n,h,p)}buildLangSelect(t){const r=document.createElement("select");for(const i of w){const a=document.createElement("option");a.value=i.code,a.textContent=i.name,i.code===t&&(a.selected=!0),r.appendChild(a)}return r}toggleExpand(){this.expanded=!this.expanded,this.expanded?(this.fab.remove(),this.anchor.appendChild(this.panel)):(this.panel.remove(),this.anchor.appendChild(this.fab))}swapLangs(){const t=this.sourceSelect.value;this.sourceSelect.value=this.targetSelect.value,this.targetSelect.value=t,this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang,targetLang:this.targetLang})}toggleCapture(){this.isCapturing?chrome.runtime.sendMessage({type:"stop-capture",target:"background"}):(this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang,targetLang:this.targetLang}),chrome.runtime.sendMessage({type:"start-capture",target:"background",sourceLang:this.sourceLang,targetLang:this.targetLang},t=>{if(chrome.runtime.lastError){this.setStatus("error",chrome.runtime.lastError.message);return}t&&!t.success&&this.setStatus("error",t.error||"Failed to start capture")}))}toggleMicTranslation(){this.isMicTranslating?chrome.runtime.sendMessage({type:"stop-mic-translation",target:"background"}):(this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.runtime.sendMessage({type:"start-mic-translation",target:"background",sourceLang:this.sourceLang,targetLang:this.targetLang},t=>{if(chrome.runtime.lastError){this.setMicStatus("error",chrome.runtime.lastError.message);return}t&&!t.success&&this.setMicStatus("error",t.error||"Failed to start mic translation")}))}setMicStatus(t,r){this.isMicTranslating=t==="translating",this.micStatusDot.className=`s-dot${t==="translating"?" capturing":t==="error"?" error":""}`,t==="translating"?(this.micStatusLabel.textContent="Your voice is being translated",this.micActionBtn.className="action-btn mic-stop",this.micActionBtn.innerHTML=`${d}<span>Stop My Voice</span>`):t==="error"?(this.micStatusLabel.textContent=r||"Mic error",this.micActionBtn.className="action-btn mic-start",this.micActionBtn.innerHTML=`${d}<span>Translate My Voice</span>`):(this.micStatusLabel.textContent="",this.micActionBtn.className="action-btn mic-start",this.micActionBtn.innerHTML=`${d}<span>Translate My Voice</span>`);const i=this.isCapturing||this.isMicTranslating;this.sourceSelect.disabled=i,this.targetSelect.disabled=i,this.swapBtn.disabled=i}setStatus(t,r){this.status=t,this.isCapturing=t==="capturing",this.fabDot.className=`fab-dot ${t}`,this.statusDot.className=`s-dot ${t}`,this.statusLabel.textContent=t==="error"?r||"Error":y[t],this.waveformEl.className=`p-waveform${this.isCapturing?" active":""}`;const i=this.waveformEl.querySelector(".wf");i&&i.classList.toggle("active",this.isCapturing);const a=this.isCapturing||this.isMicTranslating;this.sourceSelect.disabled=a,this.targetSelect.disabled=a,this.swapBtn.disabled=a,this.isCapturing?(this.actionBtn.className="action-btn stop",this.actionBtn.innerHTML=`${M}<span>Stop Translation</span>`):(this.actionBtn.className="action-btn start",this.actionBtn.innerHTML=`${b}<span>Start Translation</span>`)}renderTranscript(){const t=this.transcriptBox,r=this.transcripts.length>0||!!this.currentOrig,i=this.micTranscripts.length>0||!!this.micCurrentOrig;if(!r&&!i){t.innerHTML='<div class="t-empty">Translations will appear here</div>';return}let a="";const l=this.transcripts.slice(-3);for(const n of l)a+=`<div class="t-entry"><div class="t-source incoming">THEM</div><div class="t-orig">${this.esc(n.orig)}</div><div class="t-trans">${this.esc(n.trans)}</div></div>`;this.currentOrig&&(a+=`<div class="t-entry"><div class="t-source incoming">THEM</div><div class="t-orig">${this.esc(this.currentOrig)}</div>`,this.currentTrans&&(a+=`<div class="t-trans">${this.esc(this.currentTrans)}</div>`),a+="</div>");const o=this.micTranscripts.slice(-3);for(const n of o)a+=`<div class="t-entry"><div class="t-source">YOU</div><div class="t-orig">${this.esc(n.orig)}</div><div class="t-trans">${this.esc(n.trans)}</div></div>`;this.micCurrentOrig&&(a+=`<div class="t-entry"><div class="t-source">YOU</div><div class="t-orig">${this.esc(this.micCurrentOrig)}</div>`,this.micCurrentTrans&&(a+=`<div class="t-trans">${this.esc(this.micCurrentTrans)}</div>`),a+="</div>"),t.innerHTML=a,t.scrollTop=t.scrollHeight}listenForMessages(){chrome.runtime.onMessage.addListener(t=>{if(t.target==="popup")switch(t.type){case"status":this.setStatus(t.status);break;case"transcript":t.isFinal?this.currentOrig=(this.currentOrig+" "+t.text).trim():this.currentOrig=t.text,this.renderTranscript();break;case"translated-text":this.transcripts.push({orig:this.currentOrig,trans:t.text}),this.currentOrig="",this.currentTrans="",this.renderTranscript();break;case"translated-text-partial":this.currentTrans=t.text,this.renderTranscript();break;case"error":this.setStatus("error",t.message);break;case"mic-status":this.setMicStatus(t.status);break;case"mic-transcript":t.isFinal?this.micCurrentOrig=(this.micCurrentOrig+" "+t.text).trim():this.micCurrentOrig=t.text,this.renderTranscript();break;case"mic-translated-text":this.micTranscripts.push({orig:this.micCurrentOrig,trans:t.text}),this.micCurrentOrig="",this.micCurrentTrans="",this.renderTranscript();break;case"mic-translated-text-partial":this.micCurrentTrans=t.text,this.renderTranscript();break}})}syncState(){chrome.runtime.sendMessage({type:"get-state",target:"background"},t=>{chrome.runtime.lastError||(t!=null&&t.isCapturing&&this.setStatus("capturing"),t!=null&&t.isMicTranslating&&this.setMicStatus("translating"))})}loadSettings(){chrome.storage.sync.get(["sourceLang","targetLang"],t=>{t.sourceLang&&(this.sourceLang=t.sourceLang,this.sourceSelect.value=t.sourceLang),t.targetLang&&(this.targetLang=t.targetLang,this.targetSelect.value=t.targetLang)})}el(t,r){const i=document.createElement(t);return r&&(i.className=r),i}esc(t){const r=document.createElement("div");return r.textContent=t,r.innerHTML}destroy(){this.host.remove()}}let c=null;function x(){const s=k.test(window.location.pathname);s&&!c?c=new B:!s&&c&&(c.destroy(),c=null)}x();let m=location.href;const E=new MutationObserver(()=>{location.href!==m&&(m=location.href,x())});E.observe(document.body,{childList:!0,subtree:!0});
