import { useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, Radio, FileJson, Diff, ShieldCheck } from 'lucide-react';
import { probeEndpoint } from '../../api/client';

/**
 * Optional step that sits between "Endpoints + Auth configured" and "Generate".
 *
 * For each selected endpoint, fire one real HTTP call through /api/probe so
 * the user can:
 *   1. Verify the auth they typed actually works
 *   2. See the field shape the API actually returns (often diverges from spec)
 *   3. Capture a baseline fixture for the post-generation regression diff
 *
 * Probes are non-destructive — they hit only GET endpoints, save the response
 * to the volume, and don't change DB state until the user generates jobs.
 */
export default function ProbePanel({
  endpoints,
  selectedEndpoints,
  authConfig,
  baseUrl,
}) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState({}); // index -> ProbeResponse
  const [error, setError] = useState(null);

  const selected = endpoints
    .map((ep, i) => ({ ep, i }))
    .filter(({ i }) => selectedEndpoints.has(i));

  const runAll = async () => {
    if (!baseUrl) {
      setError('Set the API URL on step 1 first — probe needs a base URL.');
      return;
    }
    setError(null);
    setRunning(true);
    setResults({});
    // Sequentially so we don't hammer the API
    for (const { ep, i } of selected) {
      try {
        const result = await probeEndpoint({
          endpoint: ep,
          authConfig,
          baseUrl,
        });
        setResults((prev) => ({ ...prev, [i]: result }));
      } catch (err) {
        setResults((prev) => ({
          ...prev,
          [i]: { error: err.response?.data?.error || err.message || 'probe failed' },
        }));
      }
    }
    setRunning(false);
  };

  const runOne = async (ep, i) => {
    setError(null);
    setResults((prev) => ({ ...prev, [i]: { running: true } }));
    try {
      const result = await probeEndpoint({ endpoint: ep, authConfig, baseUrl });
      setResults((prev) => ({ ...prev, [i]: result }));
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [i]: { error: err.response?.data?.error || err.message },
      }));
    }
  };

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-base font-semibold flex items-center gap-2"
              style={{ color: 'rgb(var(--color-text))' }}>
            <Radio className="w-4 h-4 text-brand-600" />
            Probe with real call <span className="text-xs font-normal"
              style={{ color: 'rgb(var(--color-text-secondary))' }}>(optional)</span>
          </h3>
          <p className="text-xs mt-1" style={{ color: 'rgb(var(--color-text-secondary))' }}>
            Hit each selected endpoint once with the configured auth — captures a
            baseline fixture and verifies the API responds as expected.
          </p>
        </div>
        <button
          onClick={runAll}
          disabled={running || selected.length === 0}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
          {running ? 'Probing…' : `Probe ${selected.length} endpoint${selected.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {/* Always-visible reassurance that captures are scrubbed before disk. */}
      <div className="mt-3 p-2 rounded-lg text-xs flex items-start gap-2"
           style={{ background: 'rgb(236 253 245)', color: 'rgb(6 78 59)' }}>
        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          <strong>PHI / PII redaction on:</strong> emails, phone numbers, SSN-like values,
          and fields named like <code>name</code>, <code>address</code>, <code>dob</code>,
          <code>patient_id</code>, etc. are replaced with placeholders before fixtures
          are written to disk. Schema and types are preserved so diffs still work.
        </span>
      </div>

      {error && (
        <div className="mt-3 p-3 rounded-lg text-sm flex items-start gap-2"
             style={{ background: 'rgb(254 226 226)', color: 'rgb(127 29 29)' }}>
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {Object.keys(results).length > 0 && (
        <div className="mt-4 space-y-2">
          {selected.map(({ ep, i }) => {
            const r = results[i];
            if (!r) return null;
            return <ProbeResultRow key={i} endpoint={ep} result={r} onRerun={() => runOne(ep, i)} />;
          })}
        </div>
      )}
    </div>
  );
}

function ProbeResultRow({ endpoint, result, onRerun }) {
  if (result.running) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg text-sm"
           style={{ background: 'rgb(var(--color-surface-alt))' }}>
        <Loader2 className="w-4 h-4 animate-spin text-brand-600" />
        <span className="font-mono">{endpoint.path}</span>
        <span style={{ color: 'rgb(var(--color-text-secondary))' }}>probing…</span>
      </div>
    );
  }
  const isError = result.error || (result.statusCode && result.statusCode >= 400);
  const Icon = isError ? AlertTriangle : CheckCircle2;
  const tone = isError ? 'text-amber-600' : 'text-emerald-600';

  return (
    <div className="p-3 rounded-lg border"
         style={{
           background: 'rgb(var(--color-surface))',
           borderColor: 'rgb(var(--color-border))',
         }}>
      <div className="flex items-center gap-2 text-sm">
        <Icon className={`w-4 h-4 ${tone}`} />
        <span className="font-mono">{endpoint.path}</span>
        {result.statusCode != null && (
          <span className="px-1.5 py-0.5 rounded text-xs font-mono"
                style={{
                  background: result.statusCode >= 400 ? 'rgb(254 226 226)' : 'rgb(209 250 229)',
                  color: result.statusCode >= 400 ? 'rgb(127 29 29)' : 'rgb(6 78 59)',
                }}>
            HTTP {result.statusCode}
          </span>
        )}
        {result.recordCount > 0 && (
          <span className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
            · {result.recordCount} record{result.recordCount === 1 ? '' : 's'}
          </span>
        )}
        {result.elapsedMs != null && (
          <span className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
            · {result.elapsedMs} ms
          </span>
        )}
        {result.redacted && (
          <span className="px-1.5 py-0.5 rounded text-xs font-mono flex items-center gap-1"
                title={(result.redactedKeyPaths || []).slice(0, 20).join(', ')
                       || 'No PHI/PII patterns matched in this payload'}
                style={{
                  background: 'rgb(236 253 245)',
                  color: 'rgb(6 78 59)',
                }}>
            <ShieldCheck className="w-3 h-3" />
            {result.redactedCount > 0
              ? `${result.redactedCount} redacted`
              : 'redacted'}
          </span>
        )}
        <button onClick={onRerun} className="ml-auto btn-ghost text-xs">Re-probe</button>
      </div>

      {result.error && (
        <div className="mt-2 text-xs font-mono whitespace-pre-wrap" style={{ color: 'rgb(127 29 29)' }}>
          {result.error}
        </div>
      )}

      {result.fields && result.fields.length > 0 && (
        <div className="mt-2 text-xs flex items-start gap-2"
             style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <FileJson className="w-3.5 h-3.5 mt-0.5" />
          <span>
            <span style={{ color: 'rgb(var(--color-text))' }}>
              {result.fields.length} field{result.fields.length === 1 ? '' : 's'}:
            </span>{' '}
            {result.fields.slice(0, 12).map((f, idx) => (
              <span key={f.name + idx} className="font-mono">
                {f.name}
                <span style={{ opacity: 0.6 }}>:{(f.type || '').replace(/^id_/, '')}</span>
                {idx < Math.min(result.fields.length, 12) - 1 ? ', ' : ''}
              </span>
            ))}
            {result.fields.length > 12 && (
              <span style={{ opacity: 0.6 }}> · +{result.fields.length - 12} more</span>
            )}
          </span>
        </div>
      )}

      {result.fixturePath && (
        <div className="mt-1 text-xs flex items-center gap-2"
             style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <Diff className="w-3.5 h-3.5" />
          <span className="font-mono truncate">{result.fixturePath.split(/[\\/]/).slice(-3).join('/')}</span>
        </div>
      )}
    </div>
  );
}
