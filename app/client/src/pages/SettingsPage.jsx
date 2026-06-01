import { useState, useEffect } from 'react';
import {
  Activity, Server, Brain, Palette, Database, Cloud, Key,
  RefreshCw, CheckCircle, XCircle, Loader2, Sun, Moon, Zap, AlertTriangle, Info,
} from 'lucide-react';
import { getEngineHealth, getAiSettings, updateAiSettings, listOllamaModels, diagnoseOllama } from '../api/client';
import { useTheme } from '../context/ThemeContext';
import axios from 'axios';

// Live model lists are fetched from the provider where supported (Ollama,
// Bedrock, GitHub Models). The fallback list below is just a seed — the UI
// switches to the live list as soon as the provider is selected.
const PROVIDER_CONFIG = {
  ollama: {
    name: 'Ollama (Local)',
    icon: '🦙',
    requiresKey: false,
    liveModels: true,                // dropdown is populated from /api/ai/ollama/models
    models: [],
    description: 'Free, local LLM. No API key needed. Must be running on your machine.',
    defaultBaseUrl: 'http://localhost:11434',
  },
  openai: {
    name: 'OpenAI',
    icon: '🤖',
    requiresKey: true,
    liveModels: false,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini'],
    description: 'Cloud-hosted GPT models. Requires an OpenAI API key.',
    defaultBaseUrl: '',
  },
  anthropic: {
    name: 'Anthropic Claude',
    icon: '🧠',
    requiresKey: true,
    liveModels: false,
    models: ['claude-sonnet-4-6-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-6-20250514'],
    description: 'Cloud-hosted Claude models. Requires an Anthropic API key.',
    defaultBaseUrl: '',
  },
  bedrock: {
    name: 'AWS Bedrock',
    icon: '☁️',
    requiresKey: false,
    requiresAws: true,
    liveModels: true,                // dropdown is populated from Test Connection's response
    models: [
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'anthropic.claude-3-haiku-20240307-v1:0',
      'meta.llama3-70b-instruct-v1:0',
      'amazon.titan-text-express-v1',
    ],
    description: 'Claude, Llama, Titan, and others hosted on AWS Bedrock. Uses AWS Signature v4 — supply Access Key ID + Secret Access Key, or rely on the server\'s default AWS credential chain (env / ~/.aws/credentials / IAM role).',
    defaultBaseUrl: '',
  },
  github_copilot: {
    name: 'GitHub Copilot (via GitHub Models)',
    icon: '🐙',
    requiresKey: true,
    liveModels: true,                // populated from Test Connection (catalog/models)
    models: ['gpt-4o-mini', 'gpt-4o', 'Phi-3.5-mini-instruct', 'Meta-Llama-3.1-70B-Instruct'],
    description: 'GitHub\'s public Models API. NOTE: this is the general-purpose inference endpoint at models.github.ai — NOT the private Copilot Chat API used by VSCode. Requires a GitHub Personal Access Token with the `models:read` scope.',
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

  // Live model lists for cloud providers that expose one (Bedrock + GitHub Models).
  // Populated by testConnection on success, since the catalog/list endpoints
  // require credentials. Falls back to the static PROVIDER_CONFIG.models list.
  const [liveCloudModels, setLiveCloudModels] = useState([]); // string[]

  // AWS Bedrock-specific credentials. region is non-secret (persisted),
  // accessKeyId is sensitive but commonly known, secretAccessKey is the
  // actual secret (in-memory only, masked on GET).
  const [awsRegion, setAwsRegion] = useState('us-east-1');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretKey, setAwsSecretKey] = useState('');
  const [awsSecretKeyIsMasked, setAwsSecretKeyIsMasked] = useState(false);

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
          // Fix for "Connected to qwen2.5:7b" when qwen2.5 isn't installed:
          // if the currently-saved model isn't in the live list, clear it so
          // the dropdown falls back to "Default model" and the user is forced
          // to make an informed pick from what's actually pulled.
          const live = (models.models || []).map((m) => m.name);
          setAiModel((prev) => (prev && !live.includes(prev) ? '' : prev));
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
      // Bedrock fields
      if (settings.region) setAwsRegion(settings.region);
      if (settings.accessKeyId) setAwsAccessKeyId(settings.accessKeyId);
      if (settings.secretAccessKey) {
        setAwsSecretKey(settings.secretAccessKey);
        setAwsSecretKeyIsMasked(isRedactedKey(settings.secretAccessKey));
      } else {
        setAwsSecretKey('');
        setAwsSecretKeyIsMasked(false);
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
      // Bedrock fields (region + accessKeyId persistable; secretAccessKey in-memory)
      if (aiProvider === 'bedrock') {
        payload.region = awsRegion;
        payload.accessKeyId = awsAccessKeyId;
        if (awsSecretKey && !awsSecretKeyIsMasked) {
          payload.secretAccessKey = awsSecretKey;
        }
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
      const payload = {
        provider: aiProvider,
        apiKey: aiApiKeyIsMasked ? undefined : aiApiKey,  // don't send masked back
        model: aiModel,
        baseUrl: aiBaseUrl,
      };
      if (aiProvider === 'bedrock') {
        payload.region = awsRegion;
        payload.accessKeyId = awsAccessKeyId;
        if (!awsSecretKeyIsMasked) payload.secretAccessKey = awsSecretKey;
      }
      const resp = await axios.post('/api/ai/test-connection', payload);
      if (resp.data.success) {
        // Build a more informative success message that distinguishes
        // "service reachable" from "configured model actually works".
        const msg = resp.data.modelInstalled === false
          ? `Service reachable, but model "${resp.data.model}" isn't available`
          : `Connected — model: ${resp.data.model || '(default)'}`;
        setTestResult({ type: 'success', msg });

        // Cache live models for cloud providers that returned them
        if (Array.isArray(resp.data.modelsAvailable) && resp.data.modelsAvailable.length) {
          setLiveCloudModels(resp.data.modelsAvailable);
        }
      } else {
        setTestResult({ type: 'error', msg: resp.data.error || 'Connection failed' });
        // Even on failure, if the server reported the available list, surface it
        if (Array.isArray(resp.data.modelsAvailable) && resp.data.modelsAvailable.length) {
          setLiveCloudModels(resp.data.modelsAvailable);
        }
      }
    } catch (err) {
      setTestResult({ type: 'error', msg: err.response?.data?.error || err.message });
    } finally {
      setAiTesting(false);
      setTimeout(() => setTestResult(null), 8000);
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

          {/* API Key (not for Ollama / Bedrock) */}
          {currentProvider.requiresKey && (
            <div>
              <label className="input-label flex items-center gap-1">
                <Key className="w-3 h-3" />
                {aiProvider === 'github_copilot' ? 'GitHub PAT (models:read scope)' : 'API Key'}
              </label>
              <input
                type="password"
                value={aiApiKey}
                onChange={(e) => { setAiApiKey(e.target.value); setAiApiKeyIsMasked(false); }}
                onFocus={(e) => { if (aiApiKeyIsMasked) { setAiApiKey(''); setAiApiKeyIsMasked(false); } }}
                placeholder={`Enter ${currentProvider.name} API key`}
                className="input"
              />
              {aiProvider === 'github_copilot' && (
                <p className="text-xs mt-1" style={{ color: 'rgb(var(--color-text-muted))' }}>
                  Create one at github.com/settings/personal-access-tokens with the <code>models:read</code> scope.
                </p>
              )}
            </div>
          )}

          {/* AWS Bedrock credentials */}
          {currentProvider.requiresAws && (
            <>
              <div>
                <label className="input-label flex items-center gap-1">
                  <Cloud className="w-3 h-3" />
                  AWS Region
                </label>
                <input
                  type="text"
                  value={awsRegion}
                  onChange={(e) => setAwsRegion(e.target.value)}
                  placeholder="us-east-1"
                  className="input"
                />
              </div>
              <div>
                <label className="input-label flex items-center gap-1">
                  <Key className="w-3 h-3" />
                  AWS Access Key ID <span className="opacity-60 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={awsAccessKeyId}
                  onChange={(e) => setAwsAccessKeyId(e.target.value)}
                  placeholder="AKIA…"
                  className="input"
                />
              </div>
              <div>
                <label className="input-label flex items-center gap-1">
                  <Key className="w-3 h-3" />
                  AWS Secret Access Key <span className="opacity-60 font-normal">(optional)</span>
                </label>
                <input
                  type="password"
                  value={awsSecretKey}
                  onChange={(e) => { setAwsSecretKey(e.target.value); setAwsSecretKeyIsMasked(false); }}
                  onFocus={() => { if (awsSecretKeyIsMasked) { setAwsSecretKey(''); setAwsSecretKeyIsMasked(false); } }}
                  placeholder="(leave blank to use AWS default credential chain)"
                  className="input"
                />
                <p className="text-xs mt-1" style={{ color: 'rgb(var(--color-text-muted))' }}>
                  Leave both fields blank to fall back to the server's environment (AWS_ACCESS_KEY_ID / AWS_PROFILE / IAM role).
                </p>
              </div>
            </>
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
              {currentProvider.liveModels && aiProvider !== 'ollama' && (
                <span className="text-[10px] font-normal" style={{ color: 'rgb(var(--color-text-muted))' }}>
                  {liveCloudModels.length > 0 ? `${liveCloudModels.length} from live catalog` : 'Hit Test Connection to load live list'}
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
                : ((currentProvider.liveModels && liveCloudModels.length > 0)
                    ? liveCloudModels
                    : currentProvider.models
                  ).map((m) => (
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
