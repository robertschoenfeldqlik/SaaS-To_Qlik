/**
 * Ollama URL resolver.
 *
 * When this server runs inside Docker (which is the default deployment),
 * a user-supplied URL like `http://localhost:11434` means the CONTAINER's
 * localhost — not the host machine's. Their actual Ollama is on the host,
 * which is reachable as `host.docker.internal` on Docker Desktop
 * (Mac/Windows) and via the docker bridge gateway on Linux.
 *
 * We auto-rewrite localhost / 127.0.0.1 → host.docker.internal whenever
 * we detect a container environment, so the user can keep typing the
 * natural `http://localhost:11434` and it Just Works.
 *
 * The override env var `OLLAMA_HOST_OVERRIDE` lets ops override (e.g. set
 * to the bridge gateway IP on Linux if host.docker.internal isn't
 * configured — `--add-host=host.docker.internal:host-gateway`).
 */
const fs = require('fs');

let cachedInContainer = null;
function inContainer() {
  if (cachedInContainer !== null) return cachedInContainer;
  // /.dockerenv exists on every Docker container image we ship
  try {
    if (fs.existsSync('/.dockerenv')) {
      cachedInContainer = true;
      return true;
    }
  } catch (_) {}
  // Linux fallback: containers have "docker"/"containerd"/"kubepods" in cgroup
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker|containerd|kubepods/.test(cgroup)) {
      cachedInContainer = true;
      return true;
    }
  } catch (_) {}
  cachedInContainer = false;
  return false;
}

/** Default Ollama URL appropriate for this environment. */
function defaultOllamaUrl() {
  if (inContainer()) {
    const host = process.env.OLLAMA_HOST_OVERRIDE || 'host.docker.internal';
    return `http://${host}:11434`;
  }
  return 'http://localhost:11434';
}

/**
 * Rewrite a user-supplied Ollama base URL so it actually resolves from
 * inside this process.
 *
 *   resolveOllamaUrl()                            -> http://host.docker.internal:11434  (in container)
 *   resolveOllamaUrl('http://localhost:11434')    -> http://host.docker.internal:11434  (in container)
 *   resolveOllamaUrl('http://192.168.1.50:11434') -> unchanged
 *   resolveOllamaUrl('http://localhost:11434')    -> unchanged                          (on host)
 */
function resolveOllamaUrl(userUrl) {
  const raw = (userUrl && userUrl.trim()) || defaultOllamaUrl();
  if (!inContainer()) return raw;
  try {
    const u = new URL(raw);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') {
      const host = process.env.OLLAMA_HOST_OVERRIDE || 'host.docker.internal';
      u.hostname = host;
      return u.toString().replace(/\/$/, '');
    }
    return raw;
  } catch (_) {
    return raw;
  }
}

/**
 * Build an ordered list of candidate Ollama URLs to try. The first one that
 * responds wins.
 *
 *   - If the user gave a URL, try it as-is first.
 *   - Then try the localhost-rewritten variant (if applicable).
 *   - Then host.docker.internal and the Docker bridge gateway (172.17.0.1).
 *   - Always include localhost as a final fallback (host network mode).
 *
 * Deduplicates and strips trailing slashes.
 */
function candidatesForOllama(userUrl) {
  const list = [];

  function add(url) {
    if (!url) return;
    const cleaned = url.replace(/\/+$/, '');
    if (!list.includes(cleaned)) list.push(cleaned);
  }

  if (userUrl && userUrl.trim()) {
    const raw = userUrl.trim();
    add(raw);
    try {
      const u = new URL(raw);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') {
        // Add the docker-internal rewrite as a second candidate
        const r = new URL(raw);
        r.hostname = 'host.docker.internal';
        add(r.toString());
      }
    } catch (_) {}
  }

  if (inContainer()) {
    add('http://host.docker.internal:11434');
    if (process.env.OLLAMA_HOST_OVERRIDE) {
      add(`http://${process.env.OLLAMA_HOST_OVERRIDE}:11434`);
    }
    // Common Docker bridge gateway on Linux Docker
    add('http://172.17.0.1:11434');
  }

  // Always include localhost as a last-resort (host network mode, or running
  // outside Docker entirely)
  add('http://localhost:11434');

  return list;
}

/**
 * Probe candidates in order, returning the first that responds.
 *
 * @param userUrl    optional user-supplied base URL
 * @param axios      axios instance
 * @param timeoutMs  per-attempt HTTP timeout (default 15s, see note)
 *
 * Default timeout is 15 seconds because the cheap-looking `/api/tags`
 * endpoint can actually block for many seconds if Ollama is busy
 * cold-loading a model into RAM (large GGUF + slow disk). A 3s timeout
 * was producing false "Ollama unreachable" errors in exactly that
 * window. 15s is a reasonable upper bound that still catches genuinely
 * dead candidates quickly.
 *
 * If the FIRST candidate fails with a timeout (not a refused/DNS
 * error), retry it once before falling through to the next candidate.
 * This is the most common case: user supplied the right URL but
 * Ollama is mid-load.
 *
 * @returns {Promise<{success: boolean, url?: string, models?: Array, attempts: Array}>}
 *   attempts: [{url, ok, error?, status?}, ...] — full trace for the UI
 */
async function probeOllama(userUrl, axios, timeoutMs = 15_000) {
  const candidates = candidatesForOllama(userUrl);
  const attempts = [];

  // Two retry categories:
  //   TRANSIENT_CODES — almost always recover after a brief wait
  //     EAI_AGAIN: DNS resolver said "try again" (very common on
  //                fresh containers where Docker's internal DNS
  //                hasn't fully populated for host.docker.internal).
  //   TIMEOUT_CODES — Ollama is up but cold-loading a model
  //     ECONNABORTED / ETIMEDOUT: /api/tags itself blocked
  //
  // Refused / ENOTFOUND / etc. are PERMANENT for that URL — move on
  // immediately to the next candidate.
  const TIMEOUT_CODES   = new Set(['ECONNABORTED', 'ETIMEDOUT']);
  const TRANSIENT_CODES = new Set(['EAI_AGAIN']);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    const isFirst = i === 0;

    // First candidate gets 2 attempts on timeout (cold-load), ANY candidate
    // gets 2 attempts on a transient DNS error (EAI_AGAIN).
    for (let attemptNum = 1; attemptNum <= 2; attemptNum++) {
      try {
        const resp = await axios.get(`${url}/api/tags`, { timeout: timeoutMs });
        attempts.push({ url, ok: true, status: resp.status, retry: attemptNum > 1 });
        return { success: true, url, models: resp.data.models || [], attempts };
      } catch (e) {
        const code = e.code || e.message;
        attempts.push({
          url,
          ok: false,
          error: code,
          status: e.response?.status,
          retry: attemptNum > 1,
        });

        const isTimeout   = TIMEOUT_CODES.has(code);
        const isTransient = TRANSIENT_CODES.has(code);

        // Decide whether to retry this URL or move on:
        //   - Transient DNS (EAI_AGAIN): retry once on ANY candidate
        //   - Timeout: retry once on first candidate (cold-load Ollama)
        //   - Anything else: move on immediately
        const shouldRetry =
          attemptNum < 2 && (isTransient || (isFirst && isTimeout));

        if (!shouldRetry) break;

        // Short backoff before retry — EAI_AGAIN usually resolves
        // in well under a second.
        await wait(isTransient ? 500 : 1000);
      }
    }
  }
  return { success: false, attempts };
}

module.exports = {
  resolveOllamaUrl,
  defaultOllamaUrl,
  inContainer,
  candidatesForOllama,
  probeOllama,
};
