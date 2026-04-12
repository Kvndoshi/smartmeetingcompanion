var m=Object.defineProperty;var v=(s,t,r)=>t in s?m(s,t,{enumerable:!0,configurable:!0,writable:!0,value:r}):s[t]=r;var e=(s,t,r)=>v(s,typeof t!="symbol"?t+"":t,r);import{L as x}from"./languages-l3NF9G8N.js";const f=/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i,w={idle:"Ready",connected:"Connected",capturing:"Translating live",disconnected:"Disconnected",error:"Error"},y=`
@import url("https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap");

:host {
  all: initial;
  font-family: "DM Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  --bg: #1e1e24;
  --surface: #262630;
  --elevated: #2e2e3a;
  --hover: #363642;
  --border: #444450;
  --border-a: #5a5a68;
  --text: #fafafa;
  --text2: #c8c8d0;
  --muted: #8888a0;
  --amber: #f0c674;
  --amber-dim: rgba(240,198,116,0.15);
  --amber-glow: rgba(240,198,116,0.35);
  --green: #86efac;
  --green-dim: rgba(134,239,172,0.12);
  --red: #fca5a5;
  --red-dim: rgba(252,165,165,0.12);
  --r: 12px;
  --rs: 8px;
}

*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── FAB (minimized) ── */
.fab {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--bg);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  box-shadow: 0 4px 24px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06);
}

.fab:hover {
  border-color: var(--border-a);
  transform: scale(1.08);
  box-shadow: 0 6px 32px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.1);
}

.fab svg {
  width: 20px;
  height: 20px;
  color: var(--amber);
}

.fab-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  border: 2px solid var(--bg);
}

.fab-dot.capturing {
  background: var(--amber);
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
  width: 310px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 8px 48px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08);
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
  gap: 10px;
  padding: 14px 16px 10px;
}

.p-logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--amber-dim), transparent);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.p-logo svg { width: 14px; height: 14px; color: var(--amber); }

.p-title {
  flex: 1;
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.3px;
}

.p-waveform {
  width: 32px;
  height: 16px;
  color: var(--muted);
  transition: color 0.4s;
}

.p-waveform.active { color: var(--amber); }

.p-minimize {
  width: 24px;
  height: 24px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
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
  border-color: var(--border-a);
}

/* status */
.p-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 16px;
  font-size: 11px;
  color: var(--text2);
  font-weight: 500;
}

.s-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}

.s-dot.capturing {
  background: var(--amber);
  animation: fpulse 2s ease-in-out infinite;
}

.s-dot.connected { background: var(--green); }
.s-dot.error, .s-dot.disconnected { background: var(--red); }

/* body */
.p-body {
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* languages */
.langs {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  overflow: hidden;
}

.langs select {
  flex: 1;
  min-width: 0;
  padding: 7px 24px 7px 9px;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: var(--rs);
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' fill='%235a5a65' viewBox='0 0 16 16'%3E%3Cpath d='M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  transition: border-color 0.2s;
}

.langs select:focus {
  outline: none;
  border-color: var(--border-a);
}

.langs select:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.swap-btn {
  width: 26px;
  height: 26px;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
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
  border-color: var(--border-a);
}

.swap-btn:hover svg { transform: rotate(180deg); }
.swap-btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* action button */
.action-btn {
  width: 100%;
  padding: 10px;
  border: none;
  border-radius: 10px;
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.3s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}

.action-btn svg { width: 13px; height: 13px; }

.action-btn.start {
  background: var(--amber);
  color: #09090b;
}

.action-btn.start:hover {
  box-shadow: 0 4px 20px var(--amber-glow);
  transform: translateY(-1px);
}

.action-btn.stop {
  background: var(--elevated);
  color: var(--text);
  border: 1px solid var(--border);
}

.action-btn.stop:hover {
  background: var(--hover);
  border-color: var(--border-a);
}

/* transcript */
.transcript {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--rs);
  padding: 10px;
  max-height: 120px;
  min-height: 48px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text2);
}

.transcript::-webkit-scrollbar { width: 3px; }
.transcript::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

.t-entry {
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  animation: tup 0.3s ease;
}

.t-entry:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }

.t-orig { color: var(--muted); font-size: 10px; font-style: italic; margin-bottom: 2px; }
.t-trans { color: var(--text); font-weight: 500; font-size: 11.5px; }

.t-empty {
  color: var(--muted);
  text-align: center;
  padding: 10px 0;
  font-size: 10.5px;
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
  background: var(--surface);
  color: var(--amber);
  border: 1px solid var(--amber-dim);
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
}

.action-btn.mic-stop:hover {
  background: var(--elevated);
}

/* Mic status row */
.p-mic-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 16px 6px;
  font-size: 10px;
  color: var(--text2);
  font-weight: 500;
}

/* Transcript source label */
.t-source {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--amber);
  margin-bottom: 2px;
}

.t-source.incoming {
  color: var(--green);
}
`,p='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',L='<svg viewBox="0 0 32 20" fill="currentColor" class="wf"><rect class="wf-bar" x="3" y="6" width="3" height="8" rx="1.5"/><rect class="wf-bar" x="8.5" y="3" width="3" height="14" rx="1.5"/><rect class="wf-bar" x="14" y="1" width="3" height="18" rx="1.5"/><rect class="wf-bar" x="19.5" y="4" width="3" height="12" rx="1.5"/><rect class="wf-bar" x="25" y="6.5" width="3" height="7" rx="1.5"/></svg>',S='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16l-4-4 4-4"/><path d="M17 8l4 4-4 4"/><path d="M3 12h18"/></svg>',g='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>',k='<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',M='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',d='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';class T{constructor(){e(this,"host");e(this,"shadow");e(this,"anchor");e(this,"fab");e(this,"panel");e(this,"expanded",!1);e(this,"status","idle");e(this,"isCapturing",!1);e(this,"sourceLang","en");e(this,"targetLang","es");e(this,"transcripts",[]);e(this,"currentOrig","");e(this,"currentTrans","");e(this,"isMicTranslating",!1);e(this,"micActionBtn");e(this,"micStatusDot");e(this,"micStatusLabel");e(this,"micTranscripts",[]);e(this,"micCurrentOrig","");e(this,"micCurrentTrans","");e(this,"fabDot");e(this,"statusDot");e(this,"statusLabel");e(this,"waveformEl");e(this,"sourceSelect");e(this,"targetSelect");e(this,"swapBtn");e(this,"actionBtn");e(this,"transcriptBox");this.host=document.createElement("div"),this.host.id="interpreter-meet-widget-host",this.shadow=this.host.attachShadow({mode:"closed"});const t=document.createElement("style");t.textContent=y,this.shadow.appendChild(t),this.buildDOM(),document.body.appendChild(this.host),this.loadSettings(),this.listenForMessages(),this.syncState()}buildDOM(){this.anchor=this.el("div","widget-anchor"),this.buildFab(),this.buildPanel(),this.anchor.appendChild(this.fab),this.shadow.appendChild(this.anchor)}buildFab(){this.fab=this.el("div","fab"),this.fab.innerHTML=p,this.fabDot=this.el("div","fab-dot"),this.fab.appendChild(this.fabDot),this.fab.addEventListener("click",()=>this.toggleExpand())}buildPanel(){this.panel=this.el("div","panel");const t=this.el("div","p-header"),r=this.el("div","p-logo");r.innerHTML=p;const a=this.el("span","p-title");a.textContent="Distill",this.waveformEl=this.el("div","p-waveform"),this.waveformEl.innerHTML=L;const i=this.el("button","p-minimize");i.innerHTML=M,i.addEventListener("click",()=>this.toggleExpand()),t.append(r,a,this.waveformEl,i);const c=this.el("div","p-status");this.statusDot=this.el("div","s-dot"),this.statusLabel=this.el("span"),this.statusLabel.textContent="Ready",c.append(this.statusDot,this.statusLabel);const l=this.el("div","p-body"),n=this.el("div","langs");this.sourceSelect=this.buildLangSelect(this.sourceLang),this.targetSelect=this.buildLangSelect(this.targetLang),this.swapBtn=this.el("button","swap-btn"),this.swapBtn.innerHTML=S,this.swapBtn.addEventListener("click",()=>this.swapLangs()),n.append(this.sourceSelect,this.swapBtn,this.targetSelect),this.actionBtn=this.el("button","action-btn start"),this.actionBtn.innerHTML=`${g}<span>Start Translation</span>`,this.actionBtn.addEventListener("click",()=>this.toggleCapture()),this.micActionBtn=this.el("button","action-btn mic-start"),this.micActionBtn.innerHTML=`${d}<span>Translate My Voice</span>`,this.micActionBtn.addEventListener("click",()=>this.toggleMicTranslation()),this.transcriptBox=this.el("div","transcript"),this.transcriptBox.innerHTML='<div class="t-empty">Translations will appear here</div>';const h=this.el("div","p-mic-status");this.micStatusDot=this.el("div","s-dot"),this.micStatusLabel=this.el("span"),this.micStatusLabel.textContent="",h.append(this.micStatusDot,this.micStatusLabel),l.append(n,this.actionBtn,this.micActionBtn,this.transcriptBox),this.panel.append(t,c,h,l)}buildLangSelect(t){const r=document.createElement("select");for(const a of x){const i=document.createElement("option");i.value=a.code,i.textContent=a.name,a.code===t&&(i.selected=!0),r.appendChild(i)}return r}toggleExpand(){this.expanded=!this.expanded,this.expanded?(this.fab.remove(),this.anchor.appendChild(this.panel)):(this.panel.remove(),this.anchor.appendChild(this.fab))}swapLangs(){const t=this.sourceSelect.value;this.sourceSelect.value=this.targetSelect.value,this.targetSelect.value=t,this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang,targetLang:this.targetLang})}toggleCapture(){this.isCapturing?chrome.runtime.sendMessage({type:"stop-capture",target:"background"}):(this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.storage.sync.set({sourceLang:this.sourceLang,targetLang:this.targetLang}),chrome.runtime.sendMessage({type:"start-capture",target:"background",sourceLang:this.sourceLang,targetLang:this.targetLang},t=>{if(chrome.runtime.lastError){this.setStatus("error",chrome.runtime.lastError.message);return}t&&!t.success&&this.setStatus("error",t.error||"Failed to start capture")}))}toggleMicTranslation(){this.isMicTranslating?chrome.runtime.sendMessage({type:"stop-mic-translation",target:"background"}):(this.sourceLang=this.sourceSelect.value,this.targetLang=this.targetSelect.value,chrome.runtime.sendMessage({type:"start-mic-translation",target:"background",sourceLang:this.sourceLang,targetLang:this.targetLang},t=>{if(chrome.runtime.lastError){this.setMicStatus("error",chrome.runtime.lastError.message);return}t&&!t.success&&this.setMicStatus("error",t.error||"Failed to start mic translation")}))}setMicStatus(t,r){this.isMicTranslating=t==="translating",this.micStatusDot.className=`s-dot${t==="translating"?" capturing":t==="error"?" error":""}`,t==="translating"?(this.micStatusLabel.textContent="Your voice is being translated",this.micActionBtn.className="action-btn mic-stop",this.micActionBtn.innerHTML=`${d}<span>Stop My Voice</span>`):t==="error"?(this.micStatusLabel.textContent=r||"Mic error",this.micActionBtn.className="action-btn mic-start",this.micActionBtn.innerHTML=`${d}<span>Translate My Voice</span>`):(this.micStatusLabel.textContent="",this.micActionBtn.className="action-btn mic-start",this.micActionBtn.innerHTML=`${d}<span>Translate My Voice</span>`);const a=this.isCapturing||this.isMicTranslating;this.sourceSelect.disabled=a,this.targetSelect.disabled=a,this.swapBtn.disabled=a}setStatus(t,r){this.status=t,this.isCapturing=t==="capturing",this.fabDot.className=`fab-dot ${t}`,this.statusDot.className=`s-dot ${t}`,this.statusLabel.textContent=t==="error"?r||"Error":w[t],this.waveformEl.className=`p-waveform${this.isCapturing?" active":""}`;const a=this.waveformEl.querySelector(".wf");a&&a.classList.toggle("active",this.isCapturing);const i=this.isCapturing||this.isMicTranslating;this.sourceSelect.disabled=i,this.targetSelect.disabled=i,this.swapBtn.disabled=i,this.isCapturing?(this.actionBtn.className="action-btn stop",this.actionBtn.innerHTML=`${k}<span>Stop Translation</span>`):(this.actionBtn.className="action-btn start",this.actionBtn.innerHTML=`${g}<span>Start Translation</span>`)}renderTranscript(){const t=this.transcriptBox,r=this.transcripts.length>0||!!this.currentOrig,a=this.micTranscripts.length>0||!!this.micCurrentOrig;if(!r&&!a){t.innerHTML='<div class="t-empty">Translations will appear here</div>';return}let i="";const c=this.transcripts.slice(-3);for(const n of c)i+=`<div class="t-entry"><div class="t-source incoming">THEM</div><div class="t-orig">${this.esc(n.orig)}</div><div class="t-trans">${this.esc(n.trans)}</div></div>`;this.currentOrig&&(i+=`<div class="t-entry"><div class="t-source incoming">THEM</div><div class="t-orig">${this.esc(this.currentOrig)}</div>`,this.currentTrans&&(i+=`<div class="t-trans">${this.esc(this.currentTrans)}</div>`),i+="</div>");const l=this.micTranscripts.slice(-3);for(const n of l)i+=`<div class="t-entry"><div class="t-source">YOU</div><div class="t-orig">${this.esc(n.orig)}</div><div class="t-trans">${this.esc(n.trans)}</div></div>`;this.micCurrentOrig&&(i+=`<div class="t-entry"><div class="t-source">YOU</div><div class="t-orig">${this.esc(this.micCurrentOrig)}</div>`,this.micCurrentTrans&&(i+=`<div class="t-trans">${this.esc(this.micCurrentTrans)}</div>`),i+="</div>"),t.innerHTML=i,t.scrollTop=t.scrollHeight}listenForMessages(){chrome.runtime.onMessage.addListener(t=>{if(t.target==="popup")switch(t.type){case"status":this.setStatus(t.status);break;case"transcript":t.isFinal?this.currentOrig=(this.currentOrig+" "+t.text).trim():this.currentOrig=t.text,this.renderTranscript();break;case"translated-text":this.transcripts.push({orig:this.currentOrig,trans:t.text}),this.currentOrig="",this.currentTrans="",this.renderTranscript();break;case"translated-text-partial":this.currentTrans=t.text,this.renderTranscript();break;case"error":this.setStatus("error",t.message);break;case"mic-status":this.setMicStatus(t.status);break;case"mic-transcript":t.isFinal?this.micCurrentOrig=(this.micCurrentOrig+" "+t.text).trim():this.micCurrentOrig=t.text,this.renderTranscript();break;case"mic-translated-text":this.micTranscripts.push({orig:this.micCurrentOrig,trans:t.text}),this.micCurrentOrig="",this.micCurrentTrans="",this.renderTranscript();break;case"mic-translated-text-partial":this.micCurrentTrans=t.text,this.renderTranscript();break}})}syncState(){chrome.runtime.sendMessage({type:"get-state",target:"background"},t=>{chrome.runtime.lastError||(t!=null&&t.isCapturing&&this.setStatus("capturing"),t!=null&&t.isMicTranslating&&this.setMicStatus("translating"))})}loadSettings(){chrome.storage.sync.get(["sourceLang","targetLang"],t=>{t.sourceLang&&(this.sourceLang=t.sourceLang,this.sourceSelect.value=t.sourceLang),t.targetLang&&(this.targetLang=t.targetLang,this.targetSelect.value=t.targetLang)})}el(t,r){const a=document.createElement(t);return r&&(a.className=r),a}esc(t){const r=document.createElement("div");return r.textContent=t,r.innerHTML}destroy(){this.host.remove()}}let o=null;function b(){const s=f.test(window.location.pathname);s&&!o?o=new T:!s&&o&&(o.destroy(),o=null)}b();let u=location.href;const C=new MutationObserver(()=>{location.href!==u&&(u=location.href,b())});C.observe(document.body,{childList:!0,subtree:!0});
