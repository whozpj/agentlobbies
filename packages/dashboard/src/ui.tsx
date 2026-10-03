import { useEffect, useRef, useState, type ReactNode } from "react";

export function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="logo" aria-hidden="true">
      <path d="M5 6.5 10 10.5M19 6.5 14 10.5M12 15v4" />
      <circle cx="12" cy="12.5" r="3" />
      <circle cx="4" cy="5.5" r="2" />
      <circle cx="20" cy="5.5" r="2" />
      <circle cx="12" cy="21" r="2" />
    </svg>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot ${status}`} aria-hidden="true" />;
}

export function Avatar({ url, size = 20 }: { url: string; size?: number }) {
  return <img className="avatar" src={url} alt="" width={size} height={size} />;
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * A dialog that keeps keyboard focus inside it while open (the WAI-ARIA dialog pattern): focus moves
 * in on open, Tab and Shift+Tab wrap around, Escape closes, and focus goes back where it was.
 */
export function Modal({ title, onClose, footer, children }: { title: string; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  // Read while rendering, before an autoFocus field inside takes focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    if (!dialog.current?.contains(document.activeElement)) {
      (dialog.current?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog.current)?.focus();
    }
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const inside = dialog.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={dialog} tabIndex={-1}>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        <footer className="modal-foot">{footer}</footer>
      </div>
    </div>
  );
}

export function CopyLink({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button className="btn" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" className="lock" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function signInUrl(returnPath: string): string {
  return `/auth/github/login?return=${encodeURIComponent(returnPath)}`;
}

export function InstallSteps() {
  return (
    <pre className="install"><code>npm install -g agentlobbies{"\n"}agentlobbies install</code></pre>
  );
}
