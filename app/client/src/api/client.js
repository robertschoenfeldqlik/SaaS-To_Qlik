import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// Response interceptor for error handling
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const message = err.response?.data?.error || err.message || 'Request failed';
    console.error(`API Error [${err.config?.url}]:`, message);
    return Promise.reject(err);
  },
);

// ── Engine ──
export const discoverApi = (spec) =>
  api.post('/engine/discover', spec).then((r) => r.data);

export const generateJobs = (config) =>
  api.post('/engine/generate', config).then((r) => r.data);

export const exportWorkspace = (config) =>
  api.post('/engine/export', config, { responseType: 'blob' }).then((r) => r.data);

// Bridge endpoint: takes SQLite job IDs, regenerates them in the Java engine, returns ZIP
export const exportProjectJobs = ({ projectName, jobIds }) =>
  api.post('/projects/export', { projectName, jobIds }, {
    responseType: 'blob',
    timeout: 90000,
  }).then((r) => r.data);

export const getEngineHealth = () =>
  api.get('/engine/health', { timeout: 3000 }).then((r) => r.data);

// ── Projects ──
export const getProjects = () =>
  api.get('/projects').then((r) => r.data);

export const getProjectStats = () =>
  api.get('/projects/stats').then((r) => r.data);

export const createProject = (data) =>
  api.post('/projects', data).then((r) => r.data);

export const getProject = (id) =>
  api.get(`/projects/${id}`).then((r) => r.data);

export const updateProject = (id, data) =>
  api.put(`/projects/${id}`, data).then((r) => r.data);

export const deleteProject = (id) =>
  api.delete(`/projects/${id}`).then((r) => r.data);

// Alias for explicit SaaS project deletion (deletes project + cascades to jobs)
export const deleteSaasProject = deleteProject;

export const getProjectJobs = (id) =>
  api.get(`/projects/${id}/jobs`).then((r) => r.data);

export const saveProjectJobs = (id, jobs) =>
  api.post(`/projects/${id}/jobs`, { jobs }).then((r) => r.data);

export const deleteJob = (jobId) =>
  api.delete(`/projects/jobs/${jobId}`).then((r) => r.data);

export const deleteJobs = (ids) =>
  api.delete('/projects/jobs', { data: { ids } }).then((r) => r.data);

// ── Probe (real API calls + fixture diff) ──
export const probeEndpoint = ({ projectId, endpoint, authConfig, baseUrl }) =>
  api.post('/probe', { projectId, endpoint, authConfig, baseUrl }, { timeout: 60000 }).then((r) => r.data);

export const listFixtures = (projectId) =>
  api.get('/probe/fixtures', { params: projectId ? { projectId } : {} }).then((r) => r.data);

export const compareFixtures = ({ fixtureAId, fixtureBId, recordsPath }) =>
  api.post('/probe/compare', { fixtureAId, fixtureBId, recordsPath }).then((r) => r.data);

// ── AI ──
// /ai/fetch-url can take up to ~45s for slow docs sites — bump the default
// 30s axios timeout so the browser doesn't surface "Network Error" before
// the server has had a chance to respond.
export const fetchUrl = (url) =>
  api.post('/ai/fetch-url', { url }, { timeout: 60_000 }).then((r) => r.data);

export const generateAiConfig = (input) =>
  api.post('/ai/generate-config', input).then((r) => r.data);

export const getAiSettings = () =>
  api.get('/ai/settings').then((r) => r.data);

export const updateAiSettings = (settings) =>
  api.put('/ai/settings', settings).then((r) => r.data);

export const testAiConnection = (config) =>
  api.post('/ai/test-connection', config).then((r) => r.data);

/** Fetch the live list of models actually installed on the user's Ollama. */
export const listOllamaModels = (baseUrl) =>
  api.get('/ai/ollama/models', { params: baseUrl ? { baseUrl } : {} }).then((r) => r.data);

/** Quick diagnostic: tells the UI what base URL we'd actually use + whether we're in Docker. */
export const diagnoseOllama = (baseUrl) =>
  api.get('/ai/ollama/diagnose', { params: baseUrl ? { baseUrl } : {} }).then((r) => r.data);

// ── Database ──
export const discoverDatabase = (cfg) =>
  api.post('/engine/db/discover', cfg, { timeout: 60000 }).then((r) => r.data);

export const generateDbJobs = (cfg) =>
  api.post('/engine/db/generate', cfg, { timeout: 60000 }).then((r) => r.data);

// ── dbt ──
export const uploadDbtZip = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/dbt/upload-zip', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  }).then((r) => r.data);
};

export const fetchDbtRepo = (githubUrl) =>
  api.post('/dbt/fetch-repo', { githubUrl }, { timeout: 120000 }).then((r) => r.data);

export const parseDbtSql = (payload) =>
  api.post('/dbt/parse-sql', payload).then((r) => r.data);

export const generateDbtJobs = (cfg) =>
  api.post('/dbt/generate', cfg, { timeout: 60000 }).then((r) => r.data);

export default api;
