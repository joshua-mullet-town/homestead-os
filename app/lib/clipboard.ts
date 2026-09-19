// Clipboard helpers that work in BOTH secure (https / localhost) and
// insecure contexts. Over Tailscale the dashboard is served as plain HTTP
// (http://<host>.ts.net:3005), which is NOT a secure context, so
// navigator.clipboard is undefined and the async Clipboard API throws.
// These helpers fall back to the legacy execCommand path so copy/paste keeps
// working on the phone.

export async function copyToClipboard(text: string): Promise<boolean> {
  // Preferred path — async Clipboard API (secure contexts only).
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path below.
    }
  }

  // Fallback for insecure contexts (e.g. Tailscale HTTP on the phone).
  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export async function readFromClipboard(): Promise<string | null> {
  // readText has no reliable insecure-context fallback, so guard it instead of
  // letting it throw on the phone.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText && window.isSecureContext) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
  return null;
}
