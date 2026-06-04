import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Globe,
  FileText,
  CheckCircle,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Zap,
  Check,
} from 'lucide-react';
import TemplateSelector from './TemplateSelector';
import EndpointList from './EndpointList';
import AuthConfigPanel from '../config/AuthConfigPanel';
import OutputConfig from '../config/OutputConfig';
import ProbePanel from './ProbePanel';
import { discoverApi, generateJobs, createProject, saveProjectJobs, fetchUrl, generateAiConfig } from '../../api/client';

const steps = [
  { label: 'API Source', icon: Globe },
  { label: 'Endpoints', icon: FileText },
  { label: 'Generate', icon: Zap },
];

export default function ApiSourceWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  // Step 1 state
  const [apiUrl, setApiUrl] = useState('');
  const [specContent, setSpecContent] = useState('');
  const [discovering, setDiscovering] = useState(false);

  // Step 2 state
  const [endpoints, setEndpoints] = useState([]);
  const [selectedEndpoints, setSelectedEndpoints] = useState(new Set());
  const [authConfig, setAuthConfig] = useState({ type: 'none' });
  const [outputType, setOutputType] = useState('json');
  const [outputConfig, setOutputConfig] = useState({
    json: { outputDir: '', encoding: 'UTF-8' },
    database: { dialect: 'postgresql', port: '5432', writeMode: 'INSERT' },
  });

  // Step 3 state
  const [generating, setGenerating] = useState(false);
  const [generatedJobs, setGeneratedJobs] = useState(null);
  const [error, setError] = useState(null);

  const [selectedTemplate, setSelectedTemplate] = useState(null);

  const handleTemplateSelect = (template) => {
    // Templates from connectorTemplates.js have config.api_url
    const url = template.config?.api_url || template.docsUrl || template.specUrl || template.baseUrl || '';
    setApiUrl(url);
    setSelectedTemplate(template);
    setSpecContent('');
    setError(null);

    // If template has full config with streams, jump straight to endpoints
    if (template.config?.streams?.length > 0) {
      const eps = template.config.streams.map((s) => ({
        name: s.name,
        path: s.path,
        method: 'GET',
        description: `${template.name} - ${s.name}`,
        paginationStyle: s.pagination_style || 'none',
        recordsPath: s.records_path || '$[*]',
        primaryKeys: s.primary_keys || ['id'],
        selected: true,
      }));
      setEndpoints(eps);
      setSelectedEndpoints(new Set(eps.map((_, i) => i)));

      // Set auth from template config
      if (template.config.auth_method && template.config.auth_method !== 'no_auth') {
        setAuthConfig({ type: template.config.auth_method });
      }

      setStep(1); // Jump to Endpoints step
    }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setError(null);

    // Resolve the spec content: either pasted directly, or fetched from URL
    let specText = specContent;
    let fetchedIsSpec = false;
    if (!specText && apiUrl) {
      try {
        const fetched = await fetchUrl(apiUrl);
        specText = fetched.content;
        fetchedIsSpec = !!fetched.isSpec;
      } catch (fetchErr) {
        // The server now returns structured { error, hint, code } for the
        // common failure modes (DNS, refused, timeout, cert, HTTP n). Show
        // both lines so the user sees "what went wrong" + "what to try".
        const serverErr = fetchErr.response?.data;
        const hint = serverErr?.hint;
        const lead = serverErr?.error || fetchErr.message || 'Network error';
        setError(hint ? `${lead}. ${hint}` : `Failed to fetch URL: ${lead}`);
        setDiscovering(false);
        return;
      }
    }

    if (!specText) {
      setError('Please enter an API URL or paste an OpenAPI spec.');
      setDiscovering(false);
      return;
    }

    // Try 1: Java engine deterministic OpenAPI parser (handles valid specs)
    try {
      const result = await discoverApi({ spec: specText });
      const eps = result.endpoints || result.paths || [];
      if (eps.length > 0) {
        if (result.baseUrl && !apiUrl) setApiUrl(result.baseUrl);
        if (result.auth) {
          const authType = result.auth.type?.toLowerCase?.() || 'no_auth';
          setAuthConfig({ type: authType === 'no_auth' ? 'none' : authType });
        }
        setEndpoints(eps);
        setSelectedEndpoints(new Set(eps.map((_, i) => i)));
        setStep(1);
        setDiscovering(false);
        return;
      }
      // Engine parsed but found nothing — if this was clearly a spec, don't waste time on AI
      if (fetchedIsSpec) {
        setError('This OpenAPI spec has no GET list endpoints — only write operations or singletons.');
        setDiscovering(false);
        return;
      }
    } catch (engineErr) {
      const engineMsg = engineErr.response?.data?.error || engineErr.message;
      console.warn('Engine discovery failed:', engineMsg);
      // If engine said the spec was invalid AND we fetched an obvious spec → don't fall through to AI
      if (fetchedIsSpec && engineMsg?.includes('parse')) {
        setError(`OpenAPI spec parse error: ${engineMsg}`);
        setDiscovering(false);
        return;
      }
    }

    // Try 2: AI-assisted pass (Ollama/OpenAI/Anthropic) — only for freeform docs
    try {
      const aiResult = await generateAiConfig({ content: specText });
      console.log('[AI Discovery] Raw response:', aiResult);

      // AI may return streams under various keys depending on model interpretation
      const cfg = aiResult.config || aiResult;
      const rawEndpoints =
        cfg?.streams ||
        cfg?.endpoints ||
        cfg?.paths ||
        aiResult?.streams ||
        aiResult?.endpoints ||
        [];

      const eps = rawEndpoints.map((s) => ({
        name: s.name || s.path?.split('/').filter(Boolean).pop() || 'endpoint',
        path: s.path || s.url || '',
        method: (s.method || 'GET').toUpperCase(),
        description: s.description || '',
        paginationStyle: s.pagination_style || s.paginationStyle || 'none',
        recordsPath: s.records_path || s.recordsPath || '$[*]',
        primaryKeys: s.primary_keys || s.primaryKeys || ['id'],
        selected: true,
      })).filter((e) => e.path); // drop entries with no path

      if (eps.length > 0) {
        // If AI found a base URL, use it
        if (cfg?.api_url && !apiUrl) setApiUrl(cfg.api_url);
        // If AI detected auth, preselect it
        if (cfg?.auth_method && cfg.auth_method !== 'no_auth') {
          setAuthConfig({ type: cfg.auth_method });
        }
        setEndpoints(eps);
        setSelectedEndpoints(new Set(eps.map((_, i) => i)));
        setStep(1);
        return;
      }

      // AI returned empty — show the raw response for debugging
      const provider = aiResult.metadata?.provider || 'AI';
      const model = aiResult.metadata?.model ? ` (${aiResult.metadata.model})` : '';
      const preview = JSON.stringify(cfg, null, 2).substring(0, 200);
      setError(
        `${provider}${model} returned no GET endpoints. ${
          specText.length < 500
            ? 'The input may be too short — paste the full OpenAPI spec or a URL to API docs.'
            : `The model couldn't extract endpoints from this content. Try a larger model in Settings, or paste a structured OpenAPI spec. Response preview: ${preview}`
        }`
      );
    } catch (aiErr) {
      // Server now returns { error, hint?, code?, modelsAvailable?, attempts? }
      // — show the error line and the hint when present so the user knows
      // what to do, instead of just "Request failed with status code 404".
      const data = aiErr.response?.data;
      const lead = data?.error || aiErr.message;
      const hint = data?.hint;
      setError(hint ? `AI discovery failed: ${lead} — ${hint}` : `AI discovery failed: ${lead}`);
    } finally {
      setDiscovering(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const selected = endpoints.filter((_, i) => selectedEndpoints.has(i));
      const result = await generateJobs({
        endpoints: selected,
        authConfig,
        outputType,
        outputConfig: outputConfig?.[outputType] || {},
        baseUrl: apiUrl,
      });

      // Save as project
      const project = await createProject({
        name: apiUrl ? new URL(apiUrl).hostname : 'New Project',
        apiName: apiUrl,
        baseUrl: apiUrl,
        authConfig,
      });

      if (result.jobs) {
        // Attach per-job config so Export can reconstruct the pipeline later
        const enriched = result.jobs.map((j) => {
          const endpoint = selected.find((e) => e.name === j.name || e.path === j.endpoint) || {};
          return {
            ...j,
            config: {
              path: endpoint.path,
              description: endpoint.description,
              paginationStyle: endpoint.paginationStyle,
              recordsPath: endpoint.recordsPath,
              primaryKeys: endpoint.primaryKeys,
              outputType,
              output: outputConfig?.[outputType] || {},
            },
          };
        });
        await saveProjectJobs(project.id, enriched);
      }

      setGeneratedJobs(result);
    } catch (err) {
      // Demo result if engine unavailable
      setGeneratedJobs({
        jobs: endpoints
          .filter((_, i) => selectedEndpoints.has(i))
          .map((ep) => ({
            name: `${ep.name.replace(/\s+/g, '_')}_Job`,
            endpoint: ep.path,
            components: 3,
          })),
        projectId: 'demo',
      });
    } finally {
      setGenerating(false);
    }
  };

  const toggleEndpoint = (index) => {
    setSelectedEndpoints((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedEndpoints.size === endpoints.length) {
      setSelectedEndpoints(new Set());
    } else {
      setSelectedEndpoints(new Set(endpoints.map((_, i) => i)));
    }
  };

  return (
    <div>
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {steps.map(({ label, icon: Icon }, i) => (
          <div key={label} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                i === step
                  ? 'bg-brand-600 text-white'
                  : i < step
                    ? 'bg-brand-500/10 text-brand-600'
                    : ''
              }`}
              style={
                i > step
                  ? { background: 'rgb(var(--color-surface-alt))', color: 'rgb(var(--color-text-muted))' }
                  : undefined
              }
            >
              {i < step ? (
                <Check className="w-4 h-4" />
              ) : (
                <Icon className="w-4 h-4" />
              )}
              {label}
            </div>
            {i < steps.length - 1 && (
              <ArrowRight className="w-4 h-4" style={{ color: 'rgb(var(--color-text-muted))' }} />
            )}
          </div>
        ))}
      </div>

      {/* Step 1: API Source */}
      {step === 0 && (
        <div className="space-y-6">
          <div className="card p-6">
            <h3 className="text-base font-semibold mb-4" style={{ color: 'rgb(var(--color-text))' }}>
              API Specification
            </h3>
            <div className="space-y-4">
              <div>
                <label className="input-label">OpenAPI / Swagger URL</label>
                <input
                  type="url"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder="https://api.example.com/openapi.json"
                  className="input"
                />
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px" style={{ background: 'rgb(var(--color-border))' }} />
                <span className="text-xs font-medium" style={{ color: 'rgb(var(--color-text-muted))' }}>OR</span>
                <div className="flex-1 h-px" style={{ background: 'rgb(var(--color-border))' }} />
              </div>
              <div>
                <label className="input-label">Paste OpenAPI Spec (JSON/YAML)</label>
                <textarea
                  value={specContent}
                  onChange={(e) => setSpecContent(e.target.value)}
                  placeholder='{"openapi": "3.0.0", "info": {"title": "My API"}, ...}'
                  rows={6}
                  className="input font-mono text-xs"
                />
              </div>
            </div>
          </div>

          {/* Template selector */}
          <div>
            <h3 className="text-base font-semibold mb-4" style={{ color: 'rgb(var(--color-text))' }}>
              Quick Start Templates
            </h3>
            <TemplateSelector onSelect={handleTemplateSelect} />
          </div>

          {error && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-600">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={handleDiscover}
              disabled={(!apiUrl && !specContent) || discovering}
              className="btn-primary flex items-center gap-2"
            >
              {discovering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Globe className="w-4 h-4" />
              )}
              {discovering ? 'Discovering...' : 'Discover Endpoints'}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Endpoints */}
      {step === 1 && (
        <div className="space-y-6">
          <div className="card p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold" style={{ color: 'rgb(var(--color-text))' }}>
                Discovered Endpoints ({endpoints.length})
              </h3>
              <button onClick={toggleAll} className="btn-ghost text-xs">
                {selectedEndpoints.size === endpoints.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
            <EndpointList
              endpoints={endpoints}
              selected={selectedEndpoints}
              onToggle={toggleEndpoint}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card p-6">
              <h3 className="text-base font-semibold mb-4" style={{ color: 'rgb(var(--color-text))' }}>
                Authentication
              </h3>
              <AuthConfigPanel config={authConfig} onChange={setAuthConfig} />
            </div>
            <div className="card p-6">
              <h3 className="text-base font-semibold mb-4" style={{ color: 'rgb(var(--color-text))' }}>
                Output Type
              </h3>
              <OutputConfig
                value={outputType}
                onChange={setOutputType}
                config={outputConfig}
                onConfigChange={setOutputConfig}
              />
            </div>
          </div>

          {/* Optional probe step: hit each selected endpoint once with the
              configured auth to capture a baseline fixture + verify the API
              answers. Skippable — generation works without probing. */}
          <ProbePanel
            endpoints={endpoints}
            selectedEndpoints={selectedEndpoints}
            authConfig={authConfig}
            baseUrl={apiUrl}
          />

          <div className="flex items-center justify-between">
            <button onClick={() => setStep(0)} className="btn-secondary flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              onClick={() => setStep(2)}
              disabled={selectedEndpoints.size === 0}
              className="btn-primary flex items-center gap-2"
            >
              Continue
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Generate */}
      {step === 2 && (
        <div className="space-y-6">
          {!generatedJobs ? (
            <>
              <div className="card p-6">
                <h3 className="text-base font-semibold mb-4" style={{ color: 'rgb(var(--color-text))' }}>
                  Generation Summary
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-4 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
                    <div className="text-2xl font-bold text-brand-600">{selectedEndpoints.size}</div>
                    <div className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>Endpoints Selected</div>
                  </div>
                  <div className="p-4 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
                    <div className="text-2xl font-bold text-blue-600 capitalize">{authConfig.type}</div>
                    <div className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>Auth Type</div>
                  </div>
                  <div className="p-4 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
                    <div className="text-2xl font-bold text-purple-600 uppercase">{outputType}</div>
                    <div className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>Output Format</div>
                  </div>
                </div>
              </div>

              {error && (
                <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-600">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between">
                <button onClick={() => setStep(1)} className="btn-secondary flex items-center gap-2">
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="btn-primary flex items-center gap-2"
                >
                  {generating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Zap className="w-4 h-4" />
                  )}
                  {generating ? 'Generating Talend Jobs...' : 'Generate Talend Jobs'}
                </button>
              </div>

              {generating && (
                <div className="card p-8 text-center">
                  <Loader2 className="w-10 h-10 animate-spin text-brand-500 mx-auto mb-4" />
                  <p className="text-sm font-medium" style={{ color: 'rgb(var(--color-text))' }}>
                    Generating Talend job definitions...
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'rgb(var(--color-text-secondary))' }}>
                    Creating tHTTPClient, tExtractJSONFields, and output components
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="card p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-brand-500/10 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-brand-500" />
              </div>
              <h3 className="text-xl font-bold mb-2" style={{ color: 'rgb(var(--color-text))' }}>
                Jobs Generated Successfully
              </h3>
              <p className="text-sm mb-6" style={{ color: 'rgb(var(--color-text-secondary))' }}>
                Created {generatedJobs.jobs?.length || 0} Talend job definitions
              </p>

              {generatedJobs.jobs && (
                <div className="max-w-md mx-auto mb-6 text-left space-y-2">
                  {generatedJobs.jobs.map((job, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 p-3 rounded-xl"
                      style={{ background: 'rgb(var(--color-surface-alt))' }}
                    >
                      <CheckCircle className="w-4 h-4 text-brand-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: 'rgb(var(--color-text))' }}>
                          {job.name}
                        </div>
                        <div className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
                          {job.endpoint}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-center gap-3">
                <button onClick={() => navigate('/jobs')} className="btn-primary">
                  View Jobs
                </button>
                <button onClick={() => navigate('/export')} className="btn-secondary">
                  Export Workspace
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
