// Offscreen documents can't show permission prompts, so the microphone grant is
// requested here once (a visible extension page); it then covers the offscreen
// capture as well since both share the extension origin.
const statusEl = document.getElementById("status")!;
const button = document.getElementById("allow") as HTMLButtonElement;

function show(text: string, ok: boolean): void {
  statusEl.textContent = text;
  statusEl.className = ok ? "ok" : "err";
}

async function request(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await chrome.storage.local.set({ micPermission: "granted" });
    show("Microphone allowed — your voice is now included in the meeting notes. This tab closes by itself.", true);
    button.disabled = true;
    setTimeout(() => window.close(), 2500);
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    show(
      name === "NotAllowedError"
        ? "Permission was blocked. Click the camera/mic icon in the address bar to allow it, then try again."
        : `Couldn't open a microphone: ${err instanceof Error ? err.message : err}`,
      false
    );
  }
}

button.addEventListener("click", () => void request());
void navigator.permissions
  ?.query({ name: "microphone" as PermissionName })
  .then((p) => {
    if (p.state === "granted") show("Microphone already allowed. You can close this tab.", true);
  })
  .catch(() => {});
