import { useState, useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * Persistent amber banner advising users to point this tool at non-production
 * data sources. Captured fixtures are PHI/PII-redacted, but redaction is
 * pattern-based — it cannot guarantee zero leakage for novel field names or
 * unusual payload shapes. Sandbox / test environments are the safe path.
 *
 * Dismissal is per-session (sessionStorage), so users get reminded each time
 * they open the app rather than permanently hiding it.
 *
 * Variants:
 *   - "full"   (default): big card with icon + heading + body + dismiss
 *   - "inline": single-line, narrower, for inside cards/wizards
 */
export default function NonProdWarningBanner({ variant = 'full', storageKey = 'nonProdWarning.dismissed' }) {
  const [dismissed, setDismissed] = useState(true); // assume dismissed until we read storage

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(storageKey) === '1');
    } catch (_) {
      setDismissed(false);
    }
  }, [storageKey]);

  if (dismissed) return null;

  const handleDismiss = () => {
    try { sessionStorage.setItem(storageKey, '1'); } catch (_) {}
    setDismissed(true);
  };

  if (variant === 'inline') {
    return (
      <div className="p-2 rounded-lg text-xs flex items-start gap-2"
           style={{ background: 'rgb(254 243 199)', color: 'rgb(120 53 15)' }}>
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span className="flex-1">
          <strong>Don't point this at production.</strong>{' '}
          Use a sandbox / test tenant. Redaction is best-effort.
        </span>
        <button
          onClick={handleDismiss}
          className="opacity-60 hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 p-4 rounded-xl border-2 flex items-start gap-3"
         style={{
           background: 'rgb(254 243 199)',
           color: 'rgb(120 53 15)',
           borderColor: 'rgb(252 211 77)',
         }}>
      <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
      <div className="flex-1 text-sm leading-relaxed">
        <div className="font-semibold mb-1">
          Do not use this tool against production data sources.
        </div>
        <p>
          Connect to a <strong>sandbox, staging, or test tenant</strong> — never a live
          production system that contains real customer records. When you probe an
          endpoint, the response payload is captured to a fixture file on disk. We
          apply best-effort PHI / PII redaction (emails, phone numbers, SSN-like
          values, fields named <code>name</code>, <code>address</code>, <code>patient_id</code>,
          etc.) but pattern-based redaction <strong>cannot guarantee zero leakage</strong>
          for unusual field names or formats. The Talend jobs we generate also
          execute against whatever API base URL you provide, so a misconfigured
          probe or job against a real production tenant could move real customer
          data through this tool unintentionally.
        </p>
      </div>
      <button
        onClick={handleDismiss}
        className="opacity-60 hover:opacity-100 shrink-0"
        aria-label="Dismiss for this session"
        title="Dismiss for this session"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
