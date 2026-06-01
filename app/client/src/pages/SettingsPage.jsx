import { useState, useEffect } from 'react';
import {
  Activity, Server, Brain, Palette, Database, Cloud, Key,
  RefreshCw, CheckCircle, XCircle, Loader2, Sun, Moon, Zap, AlertTriangle, Info,
} from 'lucide-react';
import { getEngineHealth, getAiSettings, updateAiSettings, listOllamaModels, diagnoseOllama } from '../api/client';
import { useTheme } from '../context/ThemeContext';
import axios from 'axios';

// Ollama's model list is fetched LIVE from the user's installed instance
// (see fetchOllamaModels effect) — the static list below is only used for
// the cloud providers whose model menus are well-known and don't drift.
const PROVIDER_CONFIG = {
  ollama: {
    name: 'Ollama (Local)',
    icon: '🦙',
    requiresKey: false,
    models: [], // populated dynamically from /api/ai/ollama/models
    description: 'Free, local LLM. No API key needed. Must be running on your machine.',
    defaultBaseUrl: 'http://localhost:11434',
  },
  openai: {
    name: 'OpenAI',
    icon: '🤖',
    requiresKey: true,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini'],
    description: 'Cloud-hosted GPT models. Requires an OpenAI API key.',
    defaultBaseUrl: '',
  },
  anthropic: {
    name: 'Anthropic Claude',
    icon: '🧠',
    requiresKey: true,
    models: ['claude-sonnet-4-6-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-6-20250514'],
    description: 'Cloud-hosted Claude models. Requires an Anthropic API key.',
    defaultBaseUrl: '',
  },
};

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const [engineStatus, setEngineStatus] = useState('checking');
  const [enginePort] = useState(8081);

  // AI settings
  const [aiProvider, setAiProvider] = useState('ollama');
  const [aiApiKey, setAiApiKey] = useState('');
  // Track whether the field currently shows a masked key from the server.
  // If the user doesn't change it, we DON'T send it back — otherwise we'd
  // overwrite the real in-memory key with the redacted "sk-...aaaa" form.
  const [aiApiKeyIsMasked, setAiApiKeyIsMasked] = useState(false);
  const [aiModel, setAiModel] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // Live Ollama state — fetched from the user's actual instance, not hardcoded
  const [ollamaModels, setOllamaModels] = useState([]);    // [{name, parameterSize, ...}]
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaError, setOllamaError] = useState(null);    // { error, hint, attempts }
  const [ollamaDiagnose, setOllamaDiagnose] = useState(null); // { inContainer, resolvedBaseUrl, candidates }
  const [ollamaResolvedUrl, setOllamaResolvedUrl] = useState(null); // url that actually worked

  // Pattern matches the server's GET /settings redaction format.
  const isRedactedKey = (s) => {
    if (!s) return false;
    if (s === '****') return true;
    return /^.{1,12}\.\.\..{1,8}$/.test(s);
  };

  useEffect(() => {
    checkEngine();
    loadAiSettings();
  }, []);

  // Whenever the user switches TO Ollama or changes the base URL, refetch
  // the live model list. Debounced 400ms so typing in the URL field doesn't
  // hammer the server.
  useEffect(() => {
    if (aiProvider !== 'ollama') {
      setOllamaModels([]);
      setOllamaError(null);
      setOllamaDiagnose(null);
      setOllamaResolvedUrl(null);
      return;
    }
    const t = setTimeout(async () => {
      setOllamaLoading(true);
      setOllamaError(null);
      setOllamaResolvedUrl(null);
      try {
        const [diag, models] = await Promise.all([
          diagnoseOllama(aiBaseUrl || undefined).catch(() => null),
          listOllamaModels(aiBaseUrl || undefined),
        ]);
        if (diag) setOllamaDiagnose(diag);
        if (models.ok) {
          setOllamaModels(models.models || []);
          setOllamaResolvedUrl(models.resolvedBaseUrl);
        } else {
          setOllamaModels([]);
          setOllamaError({
            error: models.error,
            hint: models.hint,
            attempts: models.attempts || [],
            resolvedBaseUrl: models.resolvedBaseUrl,
          });
        }
      } catch (err) {
        setOllamaError({ error: err.message, attempts: [] });
      } finally {
        setOllamaLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [aiProvider, aiBaseUrl]);

  const checkEngine = async () => {
    setEngineStatus('checking');
    try {
      await getEngineHealth();
      setEngineStatus('online');
    } catch {
      setEngineStatus('offline');
    }
  };

  const loadAiSettings = async () => {
    try {
      const settings = await getAiSettings();
      if (settings.provider) setAiProvider(settings.provider);
      if (settings.model) setAiModel(settings.model);
      if (settings.baseUrl) setAiBaseUrl(settings.baseUrl);
      if (settings.apiKey) {
        setAiApiKey(settings.apiKey);
        setAiApiKeyIsMasked(isRedactedKey(settings.apiKey));
      } else {
        setAiApiKey('');
        setAiApiKeyIsMasked(false);
      }
    } catch {}
  };

  const saveAiSettings = async () => {
    setAiSaving(true);
    try {
      const payload = {
        provider: aiProvider,
        model: aiModel,
        baseUrl: aiBaseUrl,
      };
      // Only send the apiKey if the user typed a NEW value
      // (i.e. it's not the masked placeholder we got from the server).
      if (aiApiKey && !aiApiKeyIsMasked) {
        payload.apiKey = aiApiKey;
      }
      await updateAiSettings(payload);
      setTestResult({ type: 'success', msg: 'Settings saved' });
    } catch (err) {
      setTestResult({ type: 'error', msg: 'Failed to save settings' });
    } finally {
      setAiSaving(false);
      setTimeout(() => setTestResult(null), 4000);
    }
  };

  const testConnection = async () => {
    setAiTesting(true);
    setTestResult(null);
    try {
      const resp = await axios.post('/api/ai/test-connection', {
        provider: aiProvider,
        apiKey: aiApiKey,
        model: aiModel,
        baseUrl: aiBaseUrl,
      });
      if (resp.data.success) {
        setTestResult({ type: 'success', msg: `Connected to ${resp.data.model || aiProvider}` });
      } else {
        setTestResult({ type: 'error', msg: resp.data.error || 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ type: 'error', msg: err.response?.data?.error || err.message });
    } finally {
      setAiTesting(false);
      setTimeout(() => setTestResult(null), 6000);
    }
  };

  const currentProvider = PROVIDER_CONFIG[aiProvider] || PROVIDER_CONFIG.ollama;

  return (
    <div className="p-8 max-w-3xl mx-auto animate-fade-in-up">
      <div className="mb-8">
        <h1 className="page-header">Settings</h1>
        <p className="page-subtitle">Configure the Java engine, AI provider, and appearance</p>
      </div>

      {/* Java Engine */}
      <section className="card p-6 mb-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
            <Server className="w-5 h-5 text-purple-500" />
          </div>
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--color-text))' }}>
              Java Engine
            </h2>
            <p className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              Spring Boot engine for Talend job generation
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between p-4 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
          <div className="flex items-center gap-3">
            {engineStatus === 'checking' ? (
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            ) : engineStatus === 'online' ? (
              <CheckCircle className="w-5 h-5 text-brand-500" />
            ) : (
              <XCircle className="w-5 h-5 text-red-500" />
            )}
            <div>
              <span className="text-sm font-medium" style={{ color: 'rgb(var(--color-text))' }}>
                Status: {engineStatus === 'checking' ? 'Checking...' : engineStatus === 'online' ? 'Online' : 'Offline'}
              </span>
              <p className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
                Port {enginePort}
              </p>
            </div>
          </div>
          <button onClick={checkEngine} className="btn-secondary flex items-center gap-2 text-sm">
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </section>

      {/* AI Provider */}
      <section className="card p-6 mb-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
            <Brain className="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--color-text))' }}>
              AI Provider
            </h2>
            <p className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              LLM for API documentation analysis (supports Ollama, OpenAI, Anthropic)
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Provider selector cards */}
          <div>
            <label className="input-label">Provider</label>
            <div className="grid grid-cols-3 gap-3">
              {Object.entries(PROVIDER_CONFIG).map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => { setAiProvider(key); setAiModel(''); setTestResult(null); }}
                  className={`p-3 rounded-xl border-2 text-left transition-all ${
                    aiProvider === key
                      ? 'border-brand-500 bg-brand-500/5'
                      : 'border-transparent hover:border-gray-300'
                  }`}
                  style={{ background: aiProvider === key ? undefined : 'rgb(var(--color-surface-alt))' }}
                >
                  <div className="text-lg mb-1">{cfg.icon}</div>
                  <div className="text-sm font-medium" style={{ color: 'rgb(var(--color-text))' }}>
                    {cfg.name}
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'rgb(var(--color-text-muted))' }}>
                    {cfg.requiresKey ? 'API key required' : 'No key needed'}
                  </div>
                </button>
              ))}
            </div>
            <p className="text-xs mt-2" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              {currentProvider.description}
            </p>
          </div>

          {/* API Key (not for Ollama) */}
          {currentProvider.requiresKey && (
            <div>
              <label className="input-label flex items-center gap-1">
                <Key className="w-3 h-3" />
                API Key
              </label>
              <input
                type="password"
                value={aiApiKey}
                onChange={(e) => { setAiApiKey(e.target.value); setAiApiKeyIsMasked(false); }}
                onFocus={(e) => { if (aiApiKeyIsMasked) { setAiApiKey(''); setAiApiKeyIsMasked(false); } }}
                placeholder={`Enter ${currentProvider.name} API key`}
                className="input"
              />
            </div>
          )}

          {/* Model selector */}
          <div>
            <label className="input-label flex items-center justify-between">
              <span>Model</span>
              {aiProvider === 'ollama' && (
                <span className="text-[10px] font-normal flex items-center gap-1"
                      style={{ color: 'rgb(var(--color-text-muted))' }}>
                  {ollamaLoading
                    ? <><Loader2 className="w-3 h-3 animate-spin" /> loading…</>
                    : ollamaError
                      ? <span className="text-amber-600">Ollama unreachable</span>
                      : <>{ollamaModels.length} installed</>}
                </span>
              )}
            </label>
            <select
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              className="input"
              disabled={aiProvider === 'ollama' && ollamaLoading}
            >
              <option value="">{aiProvider === 'ollama' && ollamaModels.length === 0
                ? (ollamaError ? '(Ollama unreachable)' : '(no models installed)')
                : 'Default model'}</option>
              {aiProvider === 'ollama'
                ? ollamaModels.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}{m.parameterSize ? ` — ${m.parameterSize}` : ''}{m.quantization ? ` ${m.quantization}` : ''}
                    </option>
                  ))
                : currentProvider.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))
              }
            </select>
            {aiProvider === 'ollama' && ollamaError && (
              <div className="mt-2 p-3 rounded-lg text-xs flex items-start gap-2"
                   style={{ background: 'rgb(254 243 199)', color: 'rgb(120 53 15)' }}>
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <div className="font-semibold">Couldn't reach Ollama on any tried URL</div>
                  {ollamaError.attempts && ollamaError.attempts.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
                      {ollamaError.attempts.map((a, i) => (
                        <li key={i} className="flex items-center gap-1.5">
                          <XCircle className="w-3 h-3" />
                          {a.url} <span className="opacity-70">— {a.error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {ollamaError.hint && (
                    <div className="mt-2 leading-relaxed">{ollamaError.hint}</div>
                  )}
                  {ollamaDiagnose?.inContainer && (
                    <div className="mt-2 leading-relaxed">
                      <strong>Most common cause when this server is in Docker:</strong>{' '}
                      Ollama on the host is bound to <code>127.0.0.1:11434</code> (its
                      default). Stop Ollama, set the env var{' '}
                      <code>OLLAMA_HOST=0.0.0.0:11434</code>, then restart it.
                    </div>
                  )}
                </div>
              </div>
            )}
            {aiProvider === 'ollama' && ollamaDiagnose?.inContainer && !ollamaError && ollamaResolvedUrl && (
              <div className="mt-2 p-2 rounded-lg text-xs flex items-start gap-2"
                   style={{ background: 'rgb(219 234 254)', color: 'rgb(30 58 138)' }}>
                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  This server runs inside Docker. Connected via{' '}
                  <code>{ollamaResolvedUrl}</code> (tried {ollamaDiagnose.candidates?.length || 1}{' '}
                  candidate URL{(ollamaDiagnose.candidates?.length || 1) === 1 ? '' : 's'}).
                </span>
              </div>
            )}
          </div>

          {/* Base URL (primarily for Ollama, but also for custom OpenAI-compatible endpoints) */}
          {(aiProvider === 'ollama' || aiProvider === 'openai') && (
            <div>
              <label className="input-label flex items-center gap-1">
                <Cloud className="w-3 h-3" />
                Base URL
              </label>
              <input
                type="text"
                value={aiBaseUrl}
                onChange={(e) => setAiBaseUrl(e.target.value)}
                placeholder={currentProvider.defaultBaseUrl || 'Default'}
                className="input"
              />
              {aiProvider === 'openai' && (
                <p className="text-xs mt-1" style={{ color: 'rgb(var(--color-text-muted))' }}>
                  Leave blank for OpenAI, or set for Azure OpenAI / compatible endpoints
                </p>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={saveAiSettings}
              disabled={aiSaving}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              {aiSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save Settings
            </button>
            <button
              onClick={testConnection}
              disabled={aiTesting}
              className="btn-secondary flex items-center gap-2 text-sm"
            >
              {aiTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Test Connection
            </button>
            {testResult && (
              <span className={`text-sm flex items-center gap-1 ${testResult.type === 'success' ? 'text-brand-500' : 'text-red-500'}`}>
                {testResult.type === 'success'
                  ? <CheckCircle className="w-4 h-4" />
                  : <XCircle className="w-4 h-4" />}
                {testResult.msg}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Context Variables Info */}
      <section className="card p-6 mb-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
            <Database className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--color-text))' }}>
              Talend Context Variables
            </h2>
            <p className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              All generated jobs use context variables — never hardcoded credentials
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {[
            { group: 'API Connection', vars: ['API_BASE_URL', 'API_BEARER_TOKEN', 'API_KEY', 'API_USERNAME', 'API_PASSWORD'] },
            { group: 'OAuth2', vars: ['OAUTH2_TOKEN_URL', 'OAUTH2_CLIENT_ID', 'OAUTH2_CLIENT_SECRET'] },
            { group: 'Database', vars: ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_SCHEMA', 'DB_USERNAME', 'DB_PASSWORD', 'DB_JDBC_URL'] },
            { group: 'Qlik Cloud', vars: ['QLIK_TENANT_URL', 'QLIK_API_KEY', 'QLIK_SPACE_ID', 'QLIK_APP_ID'] },
          ].map((g) => (
            <div key={g.group} className="p-3 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
              <div className="text-xs font-semibold mb-2" style={{ color: 'rgb(var(--color-text))' }}>
                {g.group}
              </div>
              <div className="space-y-1">
                {g.vars.map((v) => (
                  <div key={v} className="text-[11px] font-mono" style={{ color: 'rgb(var(--color-text-secondary))' }}>
                    context.{v}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs mt-3" style={{ color: 'rgb(var(--color-text-muted))' }}>
          Set these in Talend Studio's context settings after importing. Password-type variables are encrypted at rest.
        </p>
      </section>

      {/* Theme */}
      <section className="card p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center">
            <Palette className="w-5 h-5 text-brand-500" />
          </div>
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--color-text))' }}>
              Appearance
            </h2>
            <p className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              Toggle between light and dark mode
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => theme !== 'light' && toggleTheme()}
            className={`flex-1 p-4 rounded-xl border-2 transition-all ${
              theme === 'light' ? 'border-brand-500 bg-brand-500/5' : 'border-transparent'
            }`}
            style={{ background: theme === 'light' ? undefined : 'rgb(var(--color-surface-alt))' }}
          >
            <Sun className="w-6 h-6 mx-auto mb-2" style={{ color: theme === 'light' ? '#009845' : 'rgb(var(--color-text-muted))' }} />
            <div className="text-sm font-medium text-center" style={{ color: 'rgb(var(--color-text))' }}>Light</div>
          </button>
          <button
            onClick={() => theme !== 'dark' && toggleTheme()}
            className={`flex-1 p-4 rounded-xl border-2 transition-all ${
              theme === 'dark' ? 'border-brand-500 bg-brand-500/5' : 'border-transparent'
            }`}
            style={{ background: theme === 'dark' ? undefined : 'rgb(var(--color-surface-alt))' }}
          >
            <Moon className="w-6 h-6 mx-auto mb-2" style={{ color: theme === 'dark' ? '#009845' : 'rgb(var(--color-text-muted))' }} />
            <div className="text-sm font-medium text-center" style={{ color: 'rgb(var(--color-text))' }}>Dark</div>
          </button>
        </div>
      </section>
    </div>
  );
}
