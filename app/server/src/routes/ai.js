const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { resolveOllamaUrl, defaultOllamaUrl, inContainer, probeOllama, candidatesForOllama } = require('../services/ollamaHost');

const router = express.Router();

// ─── AI settings ────────────────────────────────────────────────────────────
//
// Security: the API key is NEVER persisted to disk. Provider + model + baseUrl
// (non-secret config) are persisted; the key must be supplied via env var
// (OPENAI_API_KEY / ANTHROPIC_API_KEY) or set per-session via PUT /api/ai/settings
// (kept in process memory only).
//
// On startup, if a legacy ai-settings.json contains an apiKey field, we MIGRATE
// it: keep provider/model/baseUrl, drop the key, and scrub the file.
//
const SETTINGS_PATH = path.join(__dirname, '..', '..', 'data', 'ai-settings.json');

let aiSettings = {
  provider: process.env.AI_PROVIDER || 'ollama', // ollama | openai | anthropic
  apiKey: '', // never persisted — process-memory + env only
  model: '',
  baseUrl: '',
};

function envApiKey(provider) {
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  return ''; // ollama doesn't use a key
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    const loaded = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const hadKey = !!loaded.apiKey;
    aiSettings.provider = loaded.provider || aiSettings.provider;
    aiSettings.model = loaded.model || '';
    aiSettings.baseUrl = loaded.baseUrl || '';
    if (hadKey) {
      logger.warn('Found legacy apiKey in ai-settings.json — scrubbing. Use env var OPENAI_API_KEY / ANTHROPIC_API_KEY instead.');
      saveSettings(); // rewrite without the key
    } else {
      logger.info({ provider: aiSettings.provider, model: aiSettings.model }, 'Loaded AI settings from disk (key not persisted)');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to load AI settings — using defaults');
  }

  // Pull key from env if available
  const k = envApiKey(aiSettings.provider);
  if (k) {
    aiSettings.apiKey = k;
    logger.info({ provider: aiSettings.provider }, 'Loaded AI key from env var');
  }
}

function saveSettings() {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // EXCLUDE apiKey from disk persistence
    const { apiKey, ...persistable } = aiSettings;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(persistable, null, 2), 'utf8');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to persist AI settings');
  }
}

loadSettings();

// ─── LLM Provider Adapters ──────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — intentionally VERBOSE.
//
// Smaller LLMs (Qwen3 7–14B, llama3.1:8b, phi-4, granite-3) benefit from MORE
// prompting, not less. A long prompt with exhaustive rules, decision tables,
// and 8+ worked examples reduces retries and hallucinations by orders of
// magnitude on small local models. A 50-token prompt may SOUND efficient but
// causes the model to retry, wander, or invent — net token burn explodes.
//
// Target: ~3000 tokens of system prompt. This fits in an 8k context with
// 4k of input docs AND 4k of output JSON. One pass, no retries, clean JSON.
// Every section below came from a real failure mode we observed.
// ═════════════════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are a REST API integration expert. Your only job: read API documentation (OpenAPI/Swagger spec OR freeform HTML docs) and emit ONE JSON object describing every GET list endpoint so it can drive a Talend tRESTClient component.

## OUTPUT CONTRACT — return exactly this shape, nothing else

{
  "api_url": "<base URL, no trailing slash>",
  "auth_method": "no_auth" | "api_key" | "bearer_token" | "basic" | "oauth2",
  "streams": [
    {
      "name": "<snake_case resource name>",
      "path": "</path/relative/to/api_url>",
      "primary_keys": ["<field>"],
      "records_path": "<JSONPath to the array of records>",
      "pagination_style": "none" | "page" | "offset" | "cursor" | "link_header" | "jsonpath" | "odata",
      "params": { "<query param>": "<default>" },
      "description": "<one short sentence>"
    }
  ]
}

Rules that MUST hold:
- Output is ONE JSON object. No markdown fences. No prose. No thinking. JSON only.
- No trailing commas. Use double quotes for all strings.
- Always include every key shown above for each stream, even if empty.
- "params" is always an object — use {} when there are no defaults.

## INCLUSION RULES (what becomes a stream)

INCLUDE when ALL are true:
- HTTP method is GET
- Endpoint returns a list / collection / array
- Path does NOT end with a path parameter like /{id}, /:id, or /<id>

EXCLUDE silently (do not emit streams for these):
- Any POST, PUT, PATCH, DELETE, HEAD, OPTIONS endpoint
- Singleton endpoints: /me, /self, /settings, /health, /version, /ping, /status
- Endpoints that return a single resource by key (e.g. GET /users/{id})
- Auth or token endpoints (/oauth/token, /login, /logout)
- Webhook, callback, or upload endpoints

## AUTH DETECTION

Look in this order: OpenAPI securitySchemes → Authorization header examples → docs body text.
- "apiKey" in header/query/cookie              → auth_method = "api_key"
- "http" + scheme "bearer" OR "Authorization: Bearer ..." OR "token" header → auth_method = "bearer_token"
- "http" + scheme "basic" OR "Authorization: Basic ..."                     → auth_method = "basic"
- "oauth2" flow definition OR mentions of client_id/client_secret           → auth_method = "oauth2"
- Nothing in docs about auth                                                → auth_method = "no_auth"

## PAGINATION DETECTION — pick the FIRST that matches

Scan query param names (lowercased). Pagination_style decision table:

| Clue in docs/params                                            | pagination_style |
| -------------------------------------------------------------- | ---------------- |
| "cursor", "after", "next_token", "page_token", "starting_after"| cursor           |
| "offset" / "skip"  (usually paired with "limit"/"count")       | offset           |
| "page" / "page_number" / "pageNumber"                          | page             |
| RFC 5988 "Link" header, "rel=next" (GitHub-style)              | link_header      |
| "@odata.nextLink" or /odata/ in URLs                           | odata            |
| Next-URL in JSON body at "$.next" / "$.links.next" / "$.paging.next.url" | jsonpath |
| Nothing — endpoint returns all results at once                 | none             |

When unsure → use "page". Most real APIs paginate list endpoints.

## records_path — JSONPath into the response

Look at the response example/schema. Find the array that contains the records.
Common patterns (try in this order):

| Response shape                              | records_path       |
| ------------------------------------------- | ------------------ |
| { "data": [ {...}, ... ] }                  | $.data[*]          |
| { "results": [ {...}, ... ] }               | $.results[*]       |
| { "items": [ {...}, ... ] }                 | $.items[*]         |
| { "value": [ ... ] }  (OData)               | $.value[*]         |
| { "records": [ ... ] }                      | $.records[*]       |
| { "entries": [ ... ] }                      | $.entries[*]       |
| [ {...}, {...} ]  (bare array)              | $[*]               |
| { "hits": { "hits": [ ... ] } }  (Elastic)  | $.hits.hits[*]     |

When unsure → "$[*]".

## primary_keys

Take ONE field from the record that uniquely identifies it. In priority order:
"id" > "uuid" > "key" > <resourceSingular>_id > first property of record.

For composite keys (common in ERP/OData like Dynamics 365), include all of them:
["SalesOrderNumber", "dataAreaId"].

## WORKED EXAMPLES — mimic these exactly

### Example 1 — HubSpot CRM (cursor pagination, bearer auth)

Docs say: Base URL https://api.hubapi.com. Auth via "Authorization: Bearer <token>".
GET /crm/v3/objects/contacts returns {"results":[...], "paging": {"next": {"after": "..."}}}.
GET /crm/v3/objects/deals and /companies follow the same pattern.

{
  "api_url": "https://api.hubapi.com",
  "auth_method": "bearer_token",
  "streams": [
    {"name":"contacts","path":"/crm/v3/objects/contacts","primary_keys":["id"],"records_path":"$.results[*]","pagination_style":"cursor","params":{"limit":"100"},"description":"CRM contacts"},
    {"name":"companies","path":"/crm/v3/objects/companies","primary_keys":["id"],"records_path":"$.results[*]","pagination_style":"cursor","params":{"limit":"100"},"description":"CRM companies"},
    {"name":"deals","path":"/crm/v3/objects/deals","primary_keys":["id"],"records_path":"$.results[*]","pagination_style":"cursor","params":{"limit":"100"},"description":"CRM deals"}
  ]
}

### Example 2 — GitHub REST (link_header pagination, bearer)

{
  "api_url": "https://api.github.com",
  "auth_method": "bearer_token",
  "streams": [
    {"name":"repositories","path":"/user/repos","primary_keys":["id"],"records_path":"$[*]","pagination_style":"link_header","params":{"per_page":"100"},"description":"Repos accessible to the authenticated user"},
    {"name":"issues","path":"/issues","primary_keys":["id"],"records_path":"$[*]","pagination_style":"link_header","params":{"per_page":"100","state":"all"},"description":"Issues assigned to user"}
  ]
}

### Example 3 — Mailchimp (offset pagination, basic auth)

{
  "api_url": "https://<dc>.api.mailchimp.com/3.0",
  "auth_method": "basic",
  "streams": [
    {"name":"lists","path":"/lists","primary_keys":["id"],"records_path":"$.lists[*]","pagination_style":"offset","params":{"count":"100"},"description":"Email lists"},
    {"name":"campaigns","path":"/campaigns","primary_keys":["id"],"records_path":"$.campaigns[*]","pagination_style":"offset","params":{"count":"100"},"description":"Campaigns"}
  ]
}

### Example 4 — Frankfurter (no auth, single endpoint, bare object)

{
  "api_url": "https://api.frankfurter.dev",
  "auth_method": "no_auth",
  "streams": [
    {"name":"latest_rates","path":"/v1/latest","primary_keys":["date"],"records_path":"$","pagination_style":"none","params":{},"description":"Latest FX rates"},
    {"name":"currencies","path":"/v1/currencies","primary_keys":["code"],"records_path":"$","pagination_style":"none","params":{},"description":"Supported currency codes"}
  ]
}

### Example 5 — Dynamics 365 F&O (OData, OAuth2, composite keys)

{
  "api_url": "https://tenant.operations.dynamics.com/data",
  "auth_method": "oauth2",
  "streams": [
    {"name":"customers","path":"/CustomersV3","primary_keys":["CustomerAccount","dataAreaId"],"records_path":"$.value[*]","pagination_style":"odata","params":{"cross-company":"true"},"description":"Customers"},
    {"name":"sales_orders","path":"/SalesOrderHeadersV2","primary_keys":["SalesOrderNumber","dataAreaId"],"records_path":"$.value[*]","pagination_style":"odata","params":{"cross-company":"true"},"description":"Sales order headers"}
  ]
}

### Example 6 — Stripe (cursor pagination, bearer, deeply nested resources)

Docs describe GET /v1/charges, /v1/customers, /v1/invoices. All respond with
{"object":"list","url":"...","has_more":true,"data":[...]} and accept ?limit=100&starting_after=id.

{
  "api_url": "https://api.stripe.com",
  "auth_method": "bearer_token",
  "streams": [
    {"name":"charges","path":"/v1/charges","primary_keys":["id"],"records_path":"$.data[*]","pagination_style":"cursor","params":{"limit":"100"},"description":"Stripe charges"},
    {"name":"customers","path":"/v1/customers","primary_keys":["id"],"records_path":"$.data[*]","pagination_style":"cursor","params":{"limit":"100"},"description":"Stripe customers"},
    {"name":"invoices","path":"/v1/invoices","primary_keys":["id"],"records_path":"$.data[*]","pagination_style":"cursor","params":{"limit":"100"},"description":"Stripe invoices"}
  ]
}

### Example 7 — Shopify (page_info cursor inside Link header)

Shopify's REST API uses Link header with page_info=<cursor>. Treat as link_header.

{
  "api_url": "https://{shop}.myshopify.com/admin/api/2024-04",
  "auth_method": "api_key",
  "streams": [
    {"name":"orders","path":"/orders.json","primary_keys":["id"],"records_path":"$.orders[*]","pagination_style":"link_header","params":{"limit":"250","status":"any"},"description":"Orders"},
    {"name":"products","path":"/products.json","primary_keys":["id"],"records_path":"$.products[*]","pagination_style":"link_header","params":{"limit":"250"},"description":"Products"},
    {"name":"customers","path":"/customers.json","primary_keys":["id"],"records_path":"$.customers[*]","pagination_style":"link_header","params":{"limit":"250"},"description":"Customers"}
  ]
}

### Example 8 — Salesforce (OAuth2, offset via limit/offset, API key header "Authorization: Bearer")

{
  "api_url": "https://{instance}.salesforce.com/services/data/v59.0",
  "auth_method": "oauth2",
  "streams": [
    {"name":"accounts","path":"/query","primary_keys":["Id"],"records_path":"$.records[*]","pagination_style":"jsonpath","params":{"q":"SELECT Id,Name FROM Account"},"description":"Account records via SOQL"},
    {"name":"contacts","path":"/query","primary_keys":["Id"],"records_path":"$.records[*]","pagination_style":"jsonpath","params":{"q":"SELECT Id,Email,AccountId FROM Contact"},"description":"Contact records via SOQL"}
  ]
}

## COMMON FAILURE MODES — DO NOT DO THESE

WRONG ❌: "streams": []
RIGHT ✅:  Always emit at least ONE stream from the docs, even if you have to pick the most likely GET list endpoint.

WRONG ❌: "name": "GetContactsV3"            (CamelCase, verb-prefixed)
RIGHT ✅: "name": "contacts"                 (snake_case, resource-noun)

WRONG ❌: "path": "https://api.example.com/users"   (includes domain)
RIGHT ✅: "path": "/users"                          (relative to api_url)

WRONG ❌: "pagination_style": "standard"            (not in allowed list)
RIGHT ✅: "pagination_style": "page"                (use one of the 7 allowed values)

WRONG ❌: "records_path": "data"                    (missing $ and brackets)
RIGHT ✅: "records_path": "$.data[*]"               (JSONPath expression)

WRONG ❌: "primary_keys": "id"                      (must be an array of strings)
RIGHT ✅: "primary_keys": ["id"]

WRONG ❌: "params": null                            (must always be an object)
RIGHT ✅: "params": {}

WRONG ❌: Returning the spec shape like {"openapi":"3.0.0","paths":{...}}
RIGHT ✅: Return the OUTPUT CONTRACT above with streams[] built from the paths.

WRONG ❌: Wrapping output in markdown fences \`\`\`json ... \`\`\`
RIGHT ✅: Raw JSON, starts with { and ends with }

WRONG ❌: "auth_method": "token"                    (not in allowed list)
RIGHT ✅: "auth_method": "bearer_token"

WRONG ❌: Including paths with {id} at the end as streams
RIGHT ✅: Skip GET /users/{id}; only include GET /users.

## EDGE CASES

1. **Nested collection endpoints** (GET /orders/{order_id}/items):
   Include these as streams ONLY if the docs describe them as first-class list endpoints.
   Usually skip — the user can fetch items via a parent FK in the SQL layer.

2. **GraphQL schemas**: Don't try. Return {"api_url":"","auth_method":"no_auth","streams":[]}.
   GraphQL needs a different integration approach.

3. **SOAP / WSDL**: Same as GraphQL. Return empty streams.

4. **Multiple base URLs** (docs show both https://api.example.com/v1 and v2):
   Pick the most recent stable version. Note the version in each stream's description.

5. **Versioned path prefixes** (/v1/, /v2/):
   Keep them in the path; do NOT move to api_url. The path should include /v1/... .

6. **Auth with multiple options** (API key OR OAuth2):
   Pick the simpler one — usually api_key or bearer_token — unless the docs strongly recommend OAuth2.

7. **Rate-limit-only params** (X-Rate-Limit-*): Do not treat these as pagination.

8. **Sort/filter params**: Include one sensible default in "params" only when the endpoint REQUIRES it.
   Example: Shopify /orders.json requires ?status=any to see all orders (default is "open").

9. **If the docs are truncated or incomplete**: Emit what you can. Better to have 5 good streams than
   0 streams. Do NOT say "the docs are incomplete" — just produce valid JSON from what's available.

10. **Plural vs singular naming**:
    - GET /contacts → name: "contacts" (plural, it's a list)
    - GET /contact/{id} → skip (singleton)
    - GET /me/profile → skip (singleton)

## LAST WORDS

- Emit ONLY the JSON object. No \`\`\` fences. No "Here is the config:". No chain-of-thought.
- Start your response with { and end it with }. Nothing before. Nothing after.
- If you cannot find the API URL, use "" (empty string).
- If you find zero GET list endpoints, return {"api_url":"","auth_method":"no_auth","streams":[]} — never invent endpoints.
- Sort streams alphabetically by name for deterministic output.
- Trust the schema: if the docs say a field is an int64, that's what it is. Don't second-guess.
- Descriptions should be 3-8 words. Not paragraphs.
- When the same resource has multiple collection endpoints (e.g. /users and /users/active), pick the broadest one.
- If forced to choose between two interpretations of a doc, pick the one that produces valid JSON in the OUTPUT CONTRACT.`;

/**
 * Call OpenAI-compatible API (works with OpenAI, Azure OpenAI, etc.)
 */
async function callOpenAI(systemPrompt, userMessage, config) {
  const baseUrl = config.baseUrl || 'https://api.openai.com';
  const model = config.model || 'gpt-4o';

  // OpenAI's json_object mode REQUIRES the word "JSON" to appear in messages
  // Ensure the user message explicitly requests JSON output
  const userMessageWithJson = userMessage.toLowerCase().includes('json')
    ? userMessage
    : `${userMessage}\n\nReturn the response as a valid JSON object.`;

  const resp = await axios.post(`${baseUrl}/v1/chat/completions`, {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessageWithJson },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  }, {
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 120000,
  });

  return {
    text: resp.data.choices[0].message.content,
    tokens: resp.data.usage?.total_tokens || 0,
    model,
    provider: 'openai',
  };
}

/**
 * Call Ollama local LLM (no API key needed).
 *
 * Token-optimization strategy (for Qwen / small local models):
 *  1. Force format: json  → model can't wander into prose, every generated token is structural.
 *  2. Set num_predict ceiling → cap the output so a runaway model doesn't eat 30k tokens looping.
 *  3. num_ctx 8192 → Qwen3's sweet spot; larger contexts slow inference without helping schema recall.
 *  4. temperature 0.1 + top_p 0.9 → deterministic-enough for JSON, few retries.
 *  5. Qwen3 "/no_think" suffix → skip the <think>...</think> reasoning block Qwen3 emits by default,
 *     which can burn 3000+ tokens thinking before a single JSON char. Huge speedup for Qwen3 models.
 *  6. Truncate user content to ~16k chars so prompt_eval_count stays under 5k on small models.
 */
async function callOllama(systemPrompt, userMessage, config) {
  // resolveOllamaUrl auto-rewrites localhost → host.docker.internal when
  // we're running inside Docker, so the user can keep typing the natural
  // http://localhost:11434 and it Just Works.
  const baseUrl = resolveOllamaUrl(config.baseUrl);
  const model = config.model || 'llama3.1';
  const isQwen3 = /qwen3/i.test(model);

  // Qwen3 emits a <think> block by default — suppress it to save tokens.
  // Appending "/no_think" to the user message disables reasoning on Qwen3-family models.
  const userContent = isQwen3
    ? `${truncateForOllama(userMessage)}\n\n/no_think`
    : truncateForOllama(userMessage);

  const resp = await axios.post(`${baseUrl}/api/chat`, {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent },
    ],
    stream: false,
    format: 'json',              // enforce JSON — every output token is structural
    keep_alive: '5m',            // keep model loaded between calls so cold-start is 1 time
    options: {
      temperature: 0.1,          // low = deterministic JSON, few retries
      top_p: 0.9,
      num_ctx: 8192,             // Qwen/llama sweet spot; larger = slower without quality gain
      num_predict: 4096,         // cap output at 4k tokens — plenty for 50-stream configs
      repeat_penalty: 1.05,      // avoid loops while still matching the JSON schema literally
      stop: ['</s>', '```', '\n\n\n'], // early-exit on chat-template or fence tokens
    },
  }, {
    timeout: 300000,             // Ollama can be slow on first model load, fast on subsequent
  });

  // Strip Qwen3's <think>...</think> block if it slipped through despite /no_think
  let text = resp.data.message?.content || '';
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();

  return {
    text,
    tokens: (resp.data.prompt_eval_count || 0) + (resp.data.eval_count || 0),
    promptTokens: resp.data.prompt_eval_count || 0,
    outputTokens: resp.data.eval_count || 0,
    model,
    provider: 'ollama',
  };
}

/** Hard cap on input length for local models — past this, quality drops and speed cratered. */
function truncateForOllama(text, maxChars = 16000) {
  if (!text || text.length <= maxChars) return text;
  return text.substring(0, maxChars) + '\n\n[... content truncated to preserve local model context window ...]';
}

/**
 * Call Anthropic Claude API
 */
async function callAnthropic(systemPrompt, userMessage, config) {
  const model = config.model || 'claude-sonnet-4-6-20250514';

  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userMessage },
    ],
  }, {
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    timeout: 120000,
  });

  const content = resp.data.content?.[0]?.text || '';
  const tokens = (resp.data.usage?.input_tokens || 0) + (resp.data.usage?.output_tokens || 0);

  return {
    text: content,
    tokens,
    model,
    provider: 'anthropic',
  };
}

const PROVIDERS = {
  openai: callOpenAI,
  ollama: callOllama,
  anthropic: callAnthropic,
};

/**
 * Parse the AI response text to extract JSON
 */
function parseAiResponse(text) {
  // Try to extract JSON from markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  // Try to find the first { ... } block
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  return JSON.parse(text);
}

// ─── HTML to Text ───────────────────────────────────────────────────────────

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, ' `$1` ')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n## $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?(p|div|br|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/  +/g, ' ')
    .trim();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// POST /api/ai/fetch-url — Fetch URL content, strip HTML, return text
router.post('/fetch-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const response = await axios.get(url, {
      headers: { 'Accept': 'text/html,application/json,text/plain,*/*' },
      timeout: 15000,
      maxRedirects: 5,
    });

    let text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    let contentType = response.headers['content-type'] || '';

    // Detect if it's an OpenAPI/Swagger spec
    let isSpec = false;
    if (contentType.includes('json')) {
      try {
        const parsed = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        if (parsed.openapi || parsed.swagger || parsed.paths) {
          isSpec = true;
        }
      } catch {}
    }

    // Strip HTML if needed
    if (!isSpec && (text.includes('<html') || text.includes('<!DOCTYPE'))) {
      text = stripHtmlToText(text);
    }

    // Truncate to 60K chars for AI processing
    if (text.length > 60000) {
      text = text.substring(0, 60000) + '\n\n[Content truncated at 60,000 characters]';
    }

    res.json({ content: text, contentType, isSpec });
  } catch (err) {
    logger.error({ err, url: req.body.url }, 'Failed to fetch URL');
    res.status(500).json({ error: `Failed to fetch URL: ${err.message}` });
  }
});

// POST /api/ai/generate-config — Generate config from API docs using AI
router.post('/generate-config', async (req, res) => {
  try {
    const { content, prompt, provider: overrideProvider, model: overrideModel } = req.body;
    if (!content || content.length < 20) {
      return res.status(400).json({ error: 'Content must be at least 20 characters' });
    }

    // Resolve provider (per-request override or global setting)
    const effectiveProvider = overrideProvider || aiSettings.provider;
    const providerFn = PROVIDERS[effectiveProvider];
    if (!providerFn) {
      return res.status(400).json({ error: `Unknown AI provider: ${effectiveProvider}. Supported: ollama, openai, anthropic` });
    }

    // Build config for the provider call
    const config = {
      apiKey: aiSettings.apiKey,
      model: overrideModel || aiSettings.model,
      baseUrl: aiSettings.baseUrl,
    };

    // Validate API key is present for cloud providers
    if ((effectiveProvider === 'openai' || effectiveProvider === 'anthropic') && !config.apiKey) {
      return res.status(400).json({ error: `API key required for ${effectiveProvider}. Configure in Settings.` });
    }

    const userMessage = prompt
      ? `${prompt}\n\n${content}`
      : `Analyze this API documentation and generate the REST endpoint configuration:\n\n${content}`;

    logger.info({ provider: effectiveProvider, model: config.model, contentLength: content.length },
      'Starting AI config generation');

    const result = await providerFn(SYSTEM_PROMPT, userMessage, config);

    // Parse the AI response
    const parsed = parseAiResponse(result.text);

    logger.info({
      provider: effectiveProvider,
      model: config.model,
      rawResponsePreview: result.text?.substring(0, 500),
      parsedStreamsCount: parsed?.streams?.length || 0,
      parsedKeys: Object.keys(parsed || {}),
    }, 'AI generation result');

    res.json({
      config: parsed,
      streams_count: parsed.streams?.length || 0,
      metadata: {
        provider: result.provider,
        model: result.model,
        tokens: result.tokens,
      },
    });
  } catch (err) {
    logger.error({ err }, 'AI config generation failed');

    // Provide helpful error messages per provider
    let userMsg = err.message;
    if (err.response?.status === 401) {
      userMsg = 'Invalid API key. Check your API key in Settings.';
    } else if (err.code === 'ECONNREFUSED') {
      userMsg = `Cannot connect to ${aiSettings.provider}. ${
        aiSettings.provider === 'ollama'
          ? 'Is Ollama running? Start it with: ollama serve'
          : 'Check your network connection.'
      }`;
    }

    res.status(500).json({ error: `AI generation failed: ${userMsg}` });
  }
});

/**
 * GET /api/ai/ollama/models?baseUrl=...
 *
 * Returns the LIVE list of models actually installed on the user's Ollama
 * instance. The SettingsPage uses this to populate the model dropdown, so
 * we don't show a hardcoded list of models the user may or may not have
 * pulled.
 *
 * Querystring:
 *   baseUrl   optional override; if absent, uses the saved provider URL
 *             (or the Docker-aware default — http://host.docker.internal:11434
 *             inside the container, http://localhost:11434 outside).
 *
 * Response shape:
 *   {
 *     ok: true,
 *     resolvedBaseUrl: "http://host.docker.internal:11434",
 *     inContainer: true,
 *     models: [
 *       { name, size, digest, modifiedAt, parameterSize, quantization }, ...
 *     ]
 *   }
 *
 * On failure (Ollama unreachable, wrong URL, etc.):
 *   { ok: false, resolvedBaseUrl, inContainer, error, hint }
 *   HTTP 200 — we want the UI to render the diagnostic, not throw.
 */
router.get('/ollama/models', async (req, res) => {
  const userUrl = req.query.baseUrl || aiSettings.baseUrl;
  const result = await probeOllama(userUrl, axios, 3000);

  if (result.success) {
    const models = (result.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      digest: m.digest,
      modifiedAt: m.modified_at,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      family: m.details?.family,
    }));
    return res.json({
      ok: true,
      resolvedBaseUrl: result.url,
      inContainer: inContainer(),
      attempts: result.attempts,
      models,
    });
  }

  // No candidate responded — build a useful hint
  const triedList = result.attempts.map((a) => `${a.url} (${a.error})`).join('; ');
  let hint;
  if (inContainer()) {
    hint = `Tried: ${triedList}. ` +
           `Your Ollama on the host must (1) be running (\`ollama serve\`), ` +
           `and (2) be bound to 0.0.0.0:11434 — by default it listens on 127.0.0.1 ` +
           `which Docker can't reach. Set OLLAMA_HOST=0.0.0.0:11434 in Ollama's ` +
           `environment, then restart Ollama. On Linux Docker, also start this ` +
           `container with --add-host=host.docker.internal:host-gateway.`;
  } else {
    hint = `Tried: ${triedList}. Is Ollama running? Start it with: ollama serve`;
  }

  res.json({
    ok: false,
    resolvedBaseUrl: result.attempts[0]?.url,
    inContainer: inContainer(),
    attempts: result.attempts,
    error: 'No reachable Ollama endpoint',
    hint,
  });
});

/**
 * GET /api/ai/ollama/diagnose
 *
 * Diagnostic endpoint surface for the UI — returns the resolved URL it
 * WOULD use plus whether we're in a container. Lets the UI render an
 * informative hint without making a real call.
 */
router.get('/ollama/diagnose', (req, res) => {
  // Match the source of userUrl used by /ollama/models so the UI sees the
  // same candidate ordering.
  const userUrl = req.query.baseUrl || aiSettings.baseUrl;
  const candidates = candidatesForOllama(userUrl);
  res.json({
    inContainer: inContainer(),
    defaultBaseUrl: defaultOllamaUrl(),
    resolvedBaseUrl: candidates[0],  // first candidate is "preferred"
    candidates,                       // all URLs that will be tried in order
    note: inContainer()
      ? 'Running inside Docker. The server tries multiple candidate URLs in order — host.docker.internal, the Docker bridge gateway (172.17.0.1), and localhost — and uses whichever responds first. Your host Ollama must be running AND bound to 0.0.0.0:11434 (not just 127.0.0.1) for Docker to reach it.'
      : 'Running outside Docker. localhost:11434 works directly.',
  });
});

// POST /api/ai/test-connection — Test LLM connectivity
// Uses a simple ping that doesn't require JSON mode (compatible with all providers)
router.post('/test-connection', async (req, res) => {
  try {
    const { provider: testProvider, apiKey, model, baseUrl } = req.body;
    const providerName = testProvider || aiSettings.provider;

    if (!PROVIDERS[providerName]) {
      return res.status(400).json({ success: false, error: `Unknown provider: ${providerName}` });
    }

    const config = {
      apiKey: apiKey || aiSettings.apiKey,
      model: model || aiSettings.model,
      baseUrl: baseUrl || aiSettings.baseUrl,
    };

    // Validate config per provider
    if ((providerName === 'openai' || providerName === 'anthropic') && !config.apiKey) {
      return res.json({ success: false, error: `API key required for ${providerName}` });
    }

    // Minimal ping per provider — no JSON mode (some providers reject JSON mode without the word "JSON" in messages)
    let result;
    if (providerName === 'openai') {
      const url = `${config.baseUrl || 'https://api.openai.com'}/v1/chat/completions`;
      const resp = await axios.post(url, {
        model: config.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say: ok' }],
        max_tokens: 10,
      }, {
        headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      result = { model: resp.data.model, tokens: resp.data.usage?.total_tokens || 0 };
    } else if (providerName === 'anthropic') {
      const resp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: config.model || 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say: ok' }],
      }, {
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
      result = { model: resp.data.model, tokens: (resp.data.usage?.input_tokens || 0) + (resp.data.usage?.output_tokens || 0) };
    } else if (providerName === 'ollama') {
      // resolveOllamaUrl rewrites localhost → host.docker.internal when this
      // server runs inside Docker, so the user's local Ollama (on the host)
      // is actually reachable.
      const ollamaUrl = resolveOllamaUrl(config.baseUrl);
      // Ollama /api/tags is the lightest check — confirms the service is up
      const resp = await axios.get(`${ollamaUrl}/api/tags`, { timeout: 5000 });
      const modelsAvailable = (resp.data.models || []).map(m => m.name);
      result = {
        model: config.model || modelsAvailable[0] || '(none installed)',
        tokens: 0,
        modelsAvailable,
        resolvedBaseUrl: ollamaUrl,
        inContainer: inContainer(),
      };
    }

    res.json({ success: true, provider: providerName, ...result });
  } catch (err) {
    logger.error({ msg: err.message, status: err.response?.status, data: err.response?.data }, 'AI connection test failed');

    let errorMsg;
    if (err.code === 'ECONNREFUSED') {
      errorMsg = `Cannot connect. ${req.body.provider === 'ollama' ? 'Is Ollama running? Start with: ollama serve' : 'Check your network connection.'}`;
    } else if (err.response?.status === 401) {
      errorMsg = 'Invalid API key';
    } else if (err.response?.status === 404) {
      errorMsg = err.response?.data?.error?.message || 'Model not found. Check the model name.';
    } else if (err.response?.data?.error?.message) {
      errorMsg = err.response.data.error.message;
    } else if (err.response?.data?.error) {
      errorMsg = typeof err.response.data.error === 'string' ? err.response.data.error : JSON.stringify(err.response.data.error);
    } else {
      errorMsg = err.message;
    }

    res.json({ success: false, error: errorMsg });
  }
});

// GET /api/ai/settings — Get AI provider settings
router.get('/settings', (req, res) => {
  const settings = { ...aiSettings };
  // Never return the full API key
  if (settings.apiKey) {
    settings.apiKey = settings.apiKey.length > 12
      ? settings.apiKey.slice(0, 8) + '...' + settings.apiKey.slice(-4)
      : '****';
  }
  settings.configured = !!(settings.provider && (settings.provider === 'ollama' || settings.apiKey));
  settings.availableProviders = [
    { id: 'ollama', name: 'Ollama (Local)', requiresKey: false },
    { id: 'openai', name: 'OpenAI', requiresKey: true },
    { id: 'anthropic', name: 'Anthropic Claude', requiresKey: true },
  ];
  res.json(settings);
});

// Detect a redacted/masked key returned by GET /settings ("xxxxxxxx...yyyy" or "****")
// so we don't accidentally save it back as the real value.
function isMaskedKey(s) {
  if (!s) return false;
  if (s === '****') return true;
  // Format from GET: first 8 chars + '...' + last 4 chars
  return /^.{1,12}\.\.\..{1,8}$/.test(s);
}

// PUT /api/ai/settings — Update AI provider settings (key is in-memory only)
router.put('/settings', (req, res) => {
  const { provider, apiKey, model, baseUrl } = req.body;

  // Cap input lengths to prevent DoS via giant strings
  if (apiKey && apiKey.length > 500) {
    return res.status(400).json({ error: 'apiKey too long' });
  }
  if (provider && !['ollama', 'openai', 'anthropic'].includes(provider)) {
    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  }

  if (provider) aiSettings.provider = provider;
  if (model !== undefined) aiSettings.model = model;
  if (baseUrl !== undefined) aiSettings.baseUrl = baseUrl;

  // KEY HANDLING: only update if a non-redacted, non-empty value is provided.
  // This prevents the masked GET response from overwriting the real key.
  if (apiKey !== undefined && apiKey !== '' && !isMaskedKey(apiKey)) {
    aiSettings.apiKey = apiKey;
    logger.info({ provider: aiSettings.provider }, 'AI key updated in memory');
  }

  saveSettings(); // persists provider/model/baseUrl ONLY (key is excluded)
  logger.info({ provider: aiSettings.provider, model: aiSettings.model },
              'AI settings updated (provider+model+baseUrl persisted; key in-memory only)');
  res.json({ success: true });
});

module.exports = router;
