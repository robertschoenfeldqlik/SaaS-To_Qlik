import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import JobCanvas from '../components/canvas/JobCanvas';
import NodeConfigPanel from '../components/canvas/NodeConfigPanel';
import { getJob } from '../api/client';

// Maps the frontend auth-config shape onto the AUTH TYPE label shown on the
// HTTPClient node, matching the Talend Authentication.AuthorizationType enum.
const AUTH_LABEL = {
  none: 'No Auth', no_auth: 'No Auth',
  api_key: 'API Key', apikey: 'API Key',
  bearer: 'Bearer Token', bearer_token: 'Bearer Token',
  basic: 'Basic', oauth2: 'OAuth 2.0',
};

/**
 * Build the visual node/edge graph from a real job's stored config. This
 * mirrors EXACTLY what the Java engine emits at export time:
 *
 *   HTTPClient (TaCoKit) --row1--> tExtractJSONFields --row2--> tLogRow
 *                                                     \--row3--> tFileOutputJSON (or tDBOutput)
 *
 * The job config carries { path, paginationStyle, recordsPath, outputType, output },
 * and the project carries { baseUrl, authConfig }.
 */
function buildGraphFromJob(job) {
  const cfg = job.config || {};
  const project = job.project || {};
  const auth = project.authConfig || { type: 'none' };
  const baseUrl = project.baseUrl || project.apiName || 'context.API_BASE_URL';
  const path = cfg.path || job.endpoint || '/';
  const fullUrl = `${String(baseUrl).replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  const recordsPath = cfg.recordsPath || '$[*]';
  const outputType = (cfg.outputType || job.outputType || 'json').toLowerCase();
  const isDb = outputType === 'database' || outputType === 'db';

  const httpClient = {
    id: 'http-1',
    // type drives the icon/summary mapping (keyed on the Talend componentName
    // "HTTPClient"); label is the on-canvas instance name Talend shows
    // ("tHTTPClient"), matching the exported UNIQUE_NAME tHTTPClient_1.
    type: 'HTTPClient',
    label: 'tHTTPClient',
    color: '#009845',
    params: {
      URL: { type: 'TEXT', value: fullUrl },
      HTTP_METHOD: { type: 'CLOSED_LIST', value: (cfg.method || 'GET').toUpperCase(), options: ['GET', 'POST', 'PUT', 'DELETE'] },
      CONTENT_TYPE: { type: 'CLOSED_LIST', value: 'application/json', options: ['application/json', 'application/xml', 'text/plain'] },
      NEED_AUTH: { type: 'CHECK', value: (auth.type || 'none') !== 'none' },
      AUTH_TYPE: { type: 'CLOSED_LIST', value: AUTH_LABEL[(auth.type || 'none').toLowerCase()] || 'No Auth', options: ['No Auth', 'Basic', 'Bearer Token', 'API Key', 'OAuth 2.0'] },
      PAGINATION: { type: 'TEXT', value: cfg.paginationStyle || 'none' },
    },
  };

  const extract = {
    id: 'extract-1',
    type: 'tExtractJSONFields',
    label: 'tExtractJSONFields',
    color: '#22C55E',
    params: { JSON_PATH: { type: 'TEXT', value: recordsPath } },
  };

  const output = isDb
    ? {
        id: 'output-1', type: 'tDBOutput', label: 'tDBOutput', color: '#8B5CF6',
        params: { TABLE: { type: 'TEXT', value: cfg.output?.table || job.name } },
      }
    : {
        id: 'output-1', type: 'tFileOutputJSON', label: 'tFileOutputJSON', color: '#8B5CF6',
        params: { FILE_PATH: { type: 'TEXT', value: `context.OUTPUT_DIR + "/${job.name}.json"` } },
      };

  const logRow = {
    id: 'log-1', type: 'tLogRow', label: 'tLogRow', color: '#F59E0B',
    params: { TABLE_FORMAT: { type: 'CHECK', value: true } },
  };

  return {
    id: job.id,
    name: job.name,
    endpoint: path,
    status: job.status,
    config: {
      nodes: [httpClient, extract, output, logRow],
      edges: [
        { source: 'http-1', target: 'extract-1', label: 'row1' },
        { source: 'extract-1', target: 'output-1', label: 'row3' },
        { source: 'extract-1', target: 'log-1', label: 'row2' },
      ],
    },
  };
}

export default function JobCanvasPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    loadJob();
  }, [id]);

  const loadJob = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const real = await getJob(id);
      setJob(buildGraphFromJob(real));
    } catch (err) {
      console.error('Failed to load job:', err);
      setLoadError(err.response?.data?.error || err.message || 'Failed to load job');
      setJob(null);
    } finally {
      setLoading(false);
    }
  };

  const handleNodeSelect = useCallback((node) => {
    setSelectedNode(node);
  }, []);

  const handleNodeUpdate = useCallback((nodeId, params) => {
    setJob((prev) => {
      if (!prev) return prev;
      const config = { ...prev.config };
      config.nodes = config.nodes.map((n) =>
        n.id === nodeId ? { ...n, params: { ...n.params, ...params } } : n,
      );
      return { ...prev, config };
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <p style={{ color: 'rgb(var(--color-text-secondary))' }}>
          {loadError || 'Job not found.'}
        </p>
        <button onClick={() => navigate('/jobs')} className="btn-secondary flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" /> Back to Jobs
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-6 py-3 border-b shrink-0"
        style={{
          background: 'rgb(var(--color-surface))',
          borderColor: 'rgb(var(--color-border))',
        }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/jobs')}
            className="btn-ghost flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Jobs
          </button>
          <div className="h-5 w-px" style={{ background: 'rgb(var(--color-border))' }} />
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'rgb(var(--color-text))' }}>
              {job.name}
            </h2>
            <p className="text-xs" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              {job.config.nodes.length} components
            </p>
          </div>
        </div>
        <button className="btn-primary flex items-center gap-2 text-sm">
          <Download className="w-4 h-4" />
          Export This Job
        </button>
      </div>

      {/* Canvas + Config Panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1">
          <JobCanvas
            nodes={job.config.nodes}
            edges={job.config.edges}
            onNodeSelect={handleNodeSelect}
          />
        </div>
        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            onUpdate={handleNodeUpdate}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>
    </div>
  );
}
