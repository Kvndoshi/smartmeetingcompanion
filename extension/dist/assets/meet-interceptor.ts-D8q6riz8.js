(function(){let l=!1,p=null;const k=new Set;let o=null,h=null,a=null,i=null,c=null,w=null;const v=`
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSize = options?.processorOptions?.chunkSize || 4096;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      let srcOffset = 0;
      while (srcOffset < channel.length) {
        const copyLen = Math.min(this.chunkSize - this.offset, channel.length - srcOffset);
        this.buffer.set(channel.subarray(srcOffset, srcOffset + copyLen), this.offset);
        this.offset += copyLen;
        srcOffset += copyLen;
        if (this.offset === this.chunkSize) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.chunkSize);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('interpreter-mic-processor', PCMCaptureProcessor);
`;function I(){const e=new Blob([v],{type:"application/javascript"});return URL.createObjectURL(e)}function A(e,t,r){if(t===r)return e;const n=t/r,s=Math.round(e.length/n),d=new Float32Array(s);for(let u=0;u<s;u++){const m=u*n,f=Math.floor(m),S=Math.min(f+1,e.length-1),O=m-f;d[u]=e[f]*(1-O)+e[S]*O}return d}function R(e){const t=new Int16Array(e.length);for(let r=0;r<e.length;r++){const n=Math.max(-1,Math.min(1,e[r]));t[r]=n<0?n*32768:n*32767}return t}function g(e,t){const r={source:"interpreter-ext",...e};t&&t.length>0?window.postMessage(r,"*",t):window.postMessage(r,"*")}async function M(e){try{C(),o=new AudioContext({sampleRate:48e3});const t=new MediaStream([e]);h=o.createMediaStreamSource(t);const r=I();await o.audioWorklet.addModule(r),URL.revokeObjectURL(r),a=new AudioWorkletNode(o,"interpreter-mic-processor",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:"explicit",processorOptions:{chunkSize:4096}}),a.port.onmessage=s=>{const d=s.data;if(!(d instanceof Float32Array)||!o)return;const u=A(d,o.sampleRate,16e3),f=R(u).buffer.slice(0);g({type:"interpreter-mic-pcm",data:f},[f])},i=o.createMediaStreamDestination(),h.connect(a);const n=i.stream.getAudioTracks();if(n.length===0)throw new Error("[Interceptor] MediaStreamDestination produced no audio tracks");c=n[0],P(e),g({type:"interpreter-track-attached"}),console.log("[Interceptor] Audio pipeline ready")}catch(t){console.error("[Interceptor] Failed to set up audio pipeline — using passthrough:",t),C()}}function C(){T(),a&&(a.port.onmessage=null,a.disconnect(),a=null),h&&(h.disconnect(),h=null),i&&(i.disconnect(),i=null),o&&(o.close().catch(()=>{}),o=null),c=null}function P(e){T(),w=setInterval(()=>{c&&e&&(c.enabled=e.enabled)},50)}function T(){w!==null&&(clearInterval(w),w=null)}function L(e){if(!o||!i)return;const t=new Uint8Array(e),r=t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength);o.decodeAudioData(r,n=>{if(!o||!i)return;const s=o.createBufferSource();s.buffer=n,s.connect(i),s.start()},n=>{console.error("[Interceptor] decodeAudioData failed:",n)})}async function x(){if(l=!0,p&&(await M(p),c))for(const e of k)try{y.call(e,c)}catch(t){console.error("[Interceptor] replaceTrack (activate) failed:",t)}}function z(){if(l=!1,p)for(const e of k)try{y.call(e,p)}catch(t){console.error("[Interceptor] replaceTrack (deactivate) failed:",t)}C()}const b=RTCPeerConnection.prototype.addTrack,y=RTCRtpSender.prototype.replaceTrack;RTCPeerConnection.prototype.addTrack=function(e,...t){if(e.kind!=="audio")return b.call(this,e,...t);p=e;let r;if(l&&c)r=b.call(this,c,...t);else{if(l&&!c)return r=b.call(this,e,...t),k.add(r),M(e).then(()=>{if(l&&c)try{y.call(r,c)}catch(n){console.error("[Interceptor] async replaceTrack failed:",n)}}),r;r=b.call(this,e,...t)}return k.add(r),g({type:"interpreter-track-attached"}),r};RTCRtpSender.prototype.replaceTrack=function(e){return e&&e.kind==="audio"&&(p=e,l)?(M(e).then(()=>{if(l&&c)try{y.call(this,c)}catch(t){console.error("[Interceptor] re-wire replaceTrack failed:",t)}}),Promise.resolve()):y.call(this,e)};window.addEventListener("message",e=>{if(e.source!==window)return;const t=e.data;if(!(!t||t.source!=="interpreter-ext"))switch(t.type){case"interpreter-activate":x();break;case"interpreter-deactivate":z();break;case"interpreter-translated-audio":{const r=t.data;Array.isArray(r)&&L(r);break}}});console.log("[Interceptor] RTCPeerConnection and RTCRtpSender patched");
})()
