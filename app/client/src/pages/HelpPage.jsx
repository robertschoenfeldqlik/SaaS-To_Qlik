import { useState } from 'react';
import {
  BookOpen, Globe, Database, Workflow, Brain, Download, Terminal,
  FileCode, Copy, Check, ChevronDown, ChevronRight, Lightbulb, Key,
  Server, Layers, Shield, AlertTriangle,
} from 'lucide-react';

/**
 * THE EXACT LLM SYSTEM PROMPT used by /api/ai/generate-config
 * (mirrors app/server/src/routes/ai.js SYSTEM_PROMPT — kept in sync manually)
 */
const LLM_SYSTEM_PROMPT = `You are a REST API integration expert. Your only job: read API documentation (OpenAPI/Swagger spec OR freeform HTML docs) and emit ONE JSON object describing every GET list endpoint so it can drive a Talend tRESTClient component.

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

const LLM_USER_PROMPT_TEMPLATE = `Analyze this API documentation and generate the REST endpoint configuration:

<API_DOCS_OR_SPEC_CONTENT_HERE>

Return the response as a valid JSON object.`;

const LLM_TEST_PROMPT = `Say: ok`;

function CodeBlock({ children, language = 'text' }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative group">
      <button
        onClick={onCopy}
        className="absolute top-2 right-2 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: 'rgba(255,255,255,0.08)' }}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-brand-500" /> : <Copy className="w-3.5 h-3.5" style={{ color: 'rgb(var(--color-text-muted))' }} />}
      </button>
      <pre className="p-4 rounded-xl overflow-x-auto text-xs font-mono leading-relaxed"
           style={{ background: 'rgb(var(--color-surface-alt))', color: 'rgb(var(--color-text))' }}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Section({ icon: Icon, title, children, defaultOpen = true, accent = 'brand' }) {
  const [open, setOpen] = useState(defaultOpen);
  const bg = {
    brand: 'bg-brand-500/10 text-brand-500',
    blue: 'bg-blue-500/10 text-blue-500',
    purple: 'bg-purple-500/10 text-purple-500',
    amber: 'bg-amber-500/10 text-amber-500',
    emerald: 'bg-emerald-500/10 text-emerald-500',
  }[accent] || 'bg-brand-500/10 text-brand-500';

  return (
    <section className="card p-6 mb-5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 w-full text-left"
      >
        <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center shrink-0`}>
          <Icon className="w-5 h-5" />
        </div>
        <h2 className="flex-1 text-base font-semibold" style={{ color: 'rgb(var(--color-text))' }}>
          {title}
        </h2>
        {open ? <ChevronDown className="w-4 h-4" style={{ color: 'rgb(var(--color-text-muted))' }} />
              : <ChevronRight className="w-4 h-4" style={{ color: 'rgb(var(--color-text-muted))' }} />}
      </button>
      {open && <div className="mt-5 space-y-4">{children}</div>}
    </section>
  );
}

function Step({ n, title, children }) {
  return (
    <div className="flex gap-4">
      <div className="w-8 h-8 rounded-full bg-brand-500/10 flex items-center justify-center shrink-0 text-brand-600 font-bold text-sm">
        {n}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <h4 className="text-sm font-semibold mb-1" style={{ color: 'rgb(var(--color-text))' }}>{title}</h4>
        <div className="text-sm space-y-2" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function HelpPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto animate-fade-in-up">
      <div className="mb-8">
        <h1 className="page-header flex items-center gap-3">
          <BookOpen className="w-7 h-7 text-brand-500" />
          Help & Documentation
        </h1>
        <p className="page-subtitle">
          What SaaS to Talend does, how each wizard step works, and the exact prompts sent to LLMs
        </p>
      </div>

      {/* ── Purpose ──────────────────────────────────────────── */}
      <Section icon={Lightbulb} title="What is SaaS to Talend?" accent="amber">
        <p className="text-sm leading-relaxed" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <strong style={{ color: 'rgb(var(--color-text))' }}>SaaS to Talend</strong> is a desktop-style job generator
          that converts any SaaS API or relational database into a ready-to-import <em>Talend Studio workspace</em>.
          Point it at an OpenAPI spec or a database connection; it inspects the endpoints / schema, generates one
          Talend job per resource, wires up context variables for credentials, and packages everything into a ZIP you
          can <strong>File → Import</strong> directly into Talend Open Studio.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          <div className="p-4 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
            <Globe className="w-5 h-5 text-brand-500 mb-2" />
            <div className="text-sm font-semibold" style={{ color: 'rgb(var(--color-text))' }}>API Sources</div>
            <div className="text-xs mt-1" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              OpenAPI 3.x, Swagger 2.0, or freeform API docs. AI fallback via Ollama / OpenAI / Anthropic for unstructured pages.
            </div>
          </div>
          <div className="p-4 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
            <Database className="w-5 h-5 text-blue-500 mb-2" />
            <div className="text-sm font-semibold" style={{ color: 'rgb(var(--color-text))' }}>Database Sources</div>
            <div className="text-xs mt-1" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              PostgreSQL, MySQL, SQL Server, Oracle, Snowflake, Redshift, BigQuery, SQLite — JDBC schema scan.
            </div>
          </div>
          <div className="p-4 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
            <FileCode className="w-5 h-5 text-purple-500 mb-2" />
            <div className="text-sm font-semibold" style={{ color: 'rgb(var(--color-text))' }}>Outputs</div>
            <div className="text-xs mt-1" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              Talend jobs (.item/.properties) or dbt staging models (<code>stg_*.sql</code> + <code>sources.yml</code>).
            </div>
          </div>
        </div>
      </Section>

      {/* ── Architecture ─────────────────────────────────────── */}
      <Section icon={Layers} title="Architecture" accent="purple" defaultOpen={false}>
        <div className="text-sm space-y-3" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <p>Three services run side by side:</p>
          <ul className="list-disc pl-5 space-y-1.5 text-sm">
            <li><strong style={{ color: 'rgb(var(--color-text))' }}>React UI (Vite, port 5173)</strong> — wizards, job list, settings, this help page.</li>
            <li><strong style={{ color: 'rgb(var(--color-text))' }}>Express server (port 3000)</strong> — SQLite project store, AI proxy, export bridge.</li>
            <li><strong style={{ color: 'rgb(var(--color-text))' }}>Java Spring Boot engine (port 8081)</strong> — OpenAPI parser, JDBC scanner, Talend XML generator, ZIP exporter.</li>
          </ul>
          <p className="mt-2">The Java engine owns all Talend-native code (XMI 2.0 XML emission, context variables, component wiring) so generated workspaces match what Talend Studio 8.0.1 expects byte-for-byte.</p>
        </div>
      </Section>

      {/* ── API Wizard Steps ─────────────────────────────────── */}
      <Section icon={Globe} title="API Source Wizard (3 steps)" accent="brand">
        <Step n={1} title="API Source">
          <p>Provide one of:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>URL to an OpenAPI / Swagger spec</strong> — e.g. <code>https://petstore3.swagger.io/api/v3/openapi.json</code></li>
            <li><strong>Paste the spec JSON/YAML directly</strong> — for private APIs</li>
            <li><strong>Quick-start template</strong> — HubSpot, Stripe, Shopify, Dynamics 365, etc. (clicking one auto-populates endpoints and skips to step 2)</li>
          </ul>
          <p>Clicking <strong>Discover Endpoints</strong> fetches the URL (if given), then sends the content to the Java engine's deterministic parser.</p>
        </Step>

        <Step n={2} title="Endpoints + Auth">
          <p>Review every discovered GET endpoint. The engine automatically:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Skips write operations (POST/PUT/PATCH/DELETE) and singletons (/me, /{'{id}'})</li>
            <li>Infers pagination style from query params (page, offset, cursor, link_header, odata, jsonpath)</li>
            <li>Derives <code>records_path</code> from response wrappers (data, results, items, value, …)</li>
            <li>Detects auth method from <code>securitySchemes</code> (bearer, API key, basic, OAuth2)</li>
          </ul>
          <p>Uncheck endpoints you don't want. Pick an output type (JSON file / Log / Database) and fill credentials.</p>
        </Step>

        <Step n={3} title="Generate">
          <p>Click <strong>Generate Jobs</strong>. Each selected endpoint becomes one Talend job:</p>
          <CodeBlock>tRESTClient → tExtractJSONFields → tLogRow / tFileOutputJSON / tDBOutput</CodeBlock>
          <p>All credentials become Talend <code>context.*</code> variables — never hardcoded in the XML.</p>
        </Step>
      </Section>

      {/* ── Database Wizard Steps ────────────────────────────── */}
      <Section icon={Database} title="Database Source Wizard (4 steps)" accent="blue">
        <Step n={1} title="Connection">
          <p>Pick one of 8 dialects. Fill host, port (auto-filled per dialect), database, schema, username, password. Dialect-specific fields appear automatically:</p>
          <ul className="list-disc pl-5 space-y-1 text-xs">
            <li><strong>Snowflake</strong>: Warehouse, Role</li>
            <li><strong>BigQuery</strong>: GCP Project ID</li>
            <li><strong>SQLite</strong>: File Path (no host/port)</li>
          </ul>
          <p>Click <strong>Connect &amp; Scan</strong>.</p>
        </Step>

        <Step n={2} title="Schema">
          <p>The Java engine uses JDBC <code>DatabaseMetaData</code> (<code>getTables</code>, <code>getColumns</code>, <code>getPrimaryKeys</code>) to enumerate every TABLE and VIEW in the target schema. Columns appear expandable with their Talend type mapping.</p>
          <p>Select which tables to turn into jobs. System tables (pg_*, sqlite_*, sys*) are filtered out automatically.</p>
        </Step>

        <Step n={3} title="Output">
          <p>Four targets:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Database</strong> → tXxxInput → tYyyOutput (cross-dialect supported)</li>
            <li><strong>JSON File</strong> → tXxxInput → tFileOutputJSON</li>
            <li><strong>Log Row</strong> → tXxxInput → tLogRow (great for debugging)</li>
            <li><strong>dbt Staging Models</strong> → Emits <code>stg_&lt;table&gt;.sql</code> + <code>sources.yml</code> + <code>dbt_project.yml</code></li>
          </ul>
        </Step>

        <Step n={4} title="Generate">
          <p>One Talend job per selected table (or one dbt model per table). The Express layer saves the full table metadata in the project DB so <strong>Export</strong> can later regenerate the workspace without re-scanning.</p>
        </Step>
      </Section>

      {/* ── Output types ─────────────────────────────────────── */}
      <Section icon={Download} title="Exporting a Workspace" accent="emerald" defaultOpen={false}>
        <div className="text-sm space-y-3" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <p>Go to <strong>Export</strong>, pick a project name, select jobs, click <strong>Export &amp; Download</strong>. The ZIP contains:</p>
          <CodeBlock>{`ProjectName/
  talend.project
  process/
    JobName_0.1.item
    JobName_0.1.properties
  context/          (empty — required by Talend)
  code/routines/    (empty)
  metadata/         (empty)
  dbt/              (only if dbt output was selected)
    dbt_project.yml
    models/sources.yml
    models/staging/stg_*.sql`}</CodeBlock>
          <p>In Talend Studio: <strong>File → Import items</strong> → select the ZIP → all jobs + context variables appear in the repository.</p>
        </div>
      </Section>

      {/* ── Data handling / non-prod policy ──────────────────── */}
      <Section icon={AlertTriangle} title="Data handling — do NOT use production data" accent="amber" defaultOpen={true}>
        <div className="p-3 mb-3 rounded-lg border-2"
             style={{
               background: 'rgb(254 243 199)',
               color: 'rgb(120 53 15)',
               borderColor: 'rgb(252 211 77)',
             }}>
          <strong>Connect this tool to a sandbox, staging, or test tenant — never a live production system that contains real customer records.</strong>
        </div>
        <p className="text-sm mb-2" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          When you probe an endpoint or run a generated Talend job, real data from
          whatever API base URL you provide flows through this tool. Two surfaces
          can persist data to the volume-mounted filesystem at
          <code> /opt/app/server/data/fixtures</code>:
        </p>
        <ul className="text-sm list-disc pl-6 space-y-1" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <li><strong>Probe captures</strong> — when you click "Probe with real call" on the API wizard, the HTTP response body is saved as a fixture so you can later diff future captures for schema drift.</li>
          <li><strong>Error responses</strong> — 4xx / 5xx bodies are also saved (often useful for diagnosing auth regressions), and may contain identifying info.</li>
        </ul>
        <p className="text-sm mt-3 mb-2" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <strong style={{ color: 'rgb(var(--color-text))' }}>What redaction does</strong> — by default, fixtures are scrubbed in
          two passes before they hit disk:
        </p>
        <ul className="text-sm list-disc pl-6 space-y-1" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <li><strong>Field-name match</strong> on keys like <code>name</code>, <code>email</code>, <code>phone</code>, <code>ssn</code>, <code>dob</code>, <code>address</code>, <code>zip</code>, <code>mrn</code>, <code>patient_id</code>, <code>diagnosis</code>, <code>card_number</code>, <code>ip_address</code>, <code>password</code>, <code>token</code>, etc. → the value is replaced with <code>[REDACTED]</code> (or <code>0</code> / <code>false</code> / <code>[]</code> / <code>{'{}'}</code> to preserve the original JSON type for diffing).</li>
          <li><strong>Value-pattern match</strong> on regexes for email shape, US SSN (<code>NNN-NN-NNNN</code>), US phone, credit-card-shaped digit runs, IPv4 — applied to every string regardless of key, so PII inside a <code>notes</code> or <code>comment</code> column is caught.</li>
        </ul>
        <p className="text-sm mt-3" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <strong style={{ color: 'rgb(var(--color-text))' }}>What redaction does NOT guarantee</strong> — pattern-based scrubbing
          is best-effort. It cannot catch sensitive data hidden in unusual field
          names (e.g. <code>cust_ref_x9</code>), free-text descriptions without a
          recognizable shape, base64-encoded payloads, or values inside arrays that
          we recurse into without further inspection. Treat fixtures as
          <em> redacted, not anonymized to a regulatory standard</em>. They should
          not leave your environment and should not be assumed safe to share.
        </p>
        <p className="text-sm mt-3" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <strong style={{ color: 'rgb(var(--color-text))' }}>Practical guidance</strong>:
        </p>
        <ul className="text-sm list-disc pl-6 space-y-1" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <li>Use a sandbox / dev tenant with synthetic data wherever possible.</li>
          <li>If you must point at a real environment, use a read-only credential scoped to a single non-PHI endpoint.</li>
          <li>The fixtures volume is named <code>saas-talend-data</code>. To wipe captures: <code>docker volume rm saas-talend-data</code> (will also remove the SQLite project DB).</li>
          <li>For synthetic-data sandboxes where redaction is unnecessary, the probe API accepts <code>{'{ "redact": false }'}</code> to bypass scrubbing.</li>
        </ul>
      </Section>

      {/* ── Context Variables ────────────────────────────────── */}
      <Section icon={Shield} title="Context Variables (no hardcoded secrets)" accent="amber" defaultOpen={false}>
        <p className="text-sm" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          Every generated .item file declares a standard set of context parameters that the tRESTClient / tDBInput / tDBOutput components reference via <code>context.VAR_NAME</code>. Fill them in Talend Studio's context editor once per environment — the jobs carry no secrets.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {[
            { group: 'API Connection', vars: ['API_BASE_URL', 'API_BEARER_TOKEN', 'API_KEY', 'API_KEY_NAME', 'API_USERNAME', 'API_PASSWORD'] },
            { group: 'OAuth2',         vars: ['OAUTH2_TOKEN_URL', 'OAUTH2_CLIENT_ID', 'OAUTH2_CLIENT_SECRET'] },
            { group: 'Database',       vars: ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_SCHEMA', 'DB_USERNAME', 'DB_PASSWORD', 'DB_JDBC_URL'] },
            { group: 'Qlik Cloud',     vars: ['QLIK_TENANT_URL', 'QLIK_API_KEY', 'QLIK_SPACE_ID', 'QLIK_APP_ID'] },
            { group: 'Output',         vars: ['OUTPUT_DIR'] },
          ].map((g) => (
            <div key={g.group} className="p-3 rounded-xl" style={{ background: 'rgb(var(--color-surface-alt))' }}>
              <div className="text-xs font-semibold mb-2" style={{ color: 'rgb(var(--color-text))' }}>{g.group}</div>
              <div className="space-y-0.5">
                {g.vars.map((v) => (
                  <div key={v} className="text-[11px] font-mono" style={{ color: 'rgb(var(--color-text-secondary))' }}>
                    context.{v}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── The LLM Prompts (EXACT) ──────────────────────────── */}
      <Section icon={Brain} title="LLM Prompts (exact text sent to models)" accent="purple" defaultOpen={false}>
        <div className="text-sm" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <p className="mb-3">
            The deterministic Java parser handles valid OpenAPI/Swagger specs without any LLM calls.
            Only when content looks like freeform HTML/markdown docs (not a spec) does the Express layer
            call your chosen LLM provider (Ollama, OpenAI, or Anthropic).
          </p>

          <h3 className="text-sm font-semibold mt-5 mb-2" style={{ color: 'rgb(var(--color-text))' }}>
            When the LLM is called
          </h3>
          <ul className="list-disc pl-5 space-y-1 text-xs">
            <li><strong>Never</strong> — if the content is recognized as an OpenAPI 3.x / Swagger 2.0 spec</li>
            <li><strong>Never</strong> — if a spec is provided but has 0 GET list endpoints (clear error instead)</li>
            <li><strong>Only</strong> — if content is freeform docs/HTML and the deterministic parser returned nothing</li>
          </ul>
        </div>

        <h3 className="text-sm font-semibold mt-5 mb-2 flex items-center gap-2" style={{ color: 'rgb(var(--color-text))' }}>
          <Terminal className="w-4 h-4 text-brand-500" /> System prompt (every provider)
        </h3>
        <p className="text-xs mb-2" style={{ color: 'rgb(var(--color-text-muted))' }}>
          File: <code>app/server/src/routes/ai.js:42</code>
        </p>
        <CodeBlock>{LLM_SYSTEM_PROMPT}</CodeBlock>

        <h3 className="text-sm font-semibold mt-5 mb-2 flex items-center gap-2" style={{ color: 'rgb(var(--color-text))' }}>
          <Terminal className="w-4 h-4 text-blue-500" /> User prompt template
        </h3>
        <p className="text-xs mb-2" style={{ color: 'rgb(var(--color-text-muted))' }}>
          For OpenAI, the suffix <em>"Return the response as a valid JSON object."</em> is auto-appended if the word "JSON" is missing — required by OpenAI's <code>response_format: json_object</code> mode.
        </p>
        <CodeBlock>{LLM_USER_PROMPT_TEMPLATE}</CodeBlock>

        <h3 className="text-sm font-semibold mt-5 mb-2 flex items-center gap-2" style={{ color: 'rgb(var(--color-text))' }}>
          <Terminal className="w-4 h-4 text-purple-500" /> Test Connection prompt
        </h3>
        <p className="text-xs mb-2" style={{ color: 'rgb(var(--color-text-muted))' }}>
          Used by Settings → Test Connection. For Ollama it's replaced with a GET <code>/api/tags</code> call so we don't need to invoke the model.
        </p>
        <CodeBlock>{LLM_TEST_PROMPT}</CodeBlock>

        <h3 className="text-sm font-semibold mt-5 mb-2" style={{ color: 'rgb(var(--color-text))' }}>
          Per-provider call parameters
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-3 rounded-xl text-xs" style={{ background: 'rgb(var(--color-surface-alt))' }}>
            <div className="text-sm font-semibold mb-1" style={{ color: 'rgb(var(--color-text))' }}>🤖 OpenAI</div>
            <div className="font-mono space-y-0.5" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              <div>POST /v1/chat/completions</div>
              <div>model: gpt-4o (default)</div>
              <div>temperature: 0.1</div>
              <div>response_format: json_object</div>
              <div>timeout: 120s</div>
            </div>
          </div>
          <div className="p-3 rounded-xl text-xs" style={{ background: 'rgb(var(--color-surface-alt))' }}>
            <div className="text-sm font-semibold mb-1" style={{ color: 'rgb(var(--color-text))' }}>🦙 Ollama (Qwen-tuned)</div>
            <div className="font-mono space-y-0.5" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              <div>POST /api/chat</div>
              <div>model: llama3.1 (default)</div>
              <div>temperature: 0.1 · top_p: 0.9</div>
              <div>num_ctx: 8192 · num_predict: 4096</div>
              <div>format: json · stream: false</div>
              <div>keep_alive: 5m</div>
              <div>repeat_penalty: 1.05</div>
              <div>stop: [&lt;/s&gt;, ```, \n\n\n]</div>
              <div>Qwen3 only: append &quot;/no_think&quot;</div>
            </div>
          </div>
          <div className="p-3 rounded-xl text-xs" style={{ background: 'rgb(var(--color-surface-alt))' }}>
            <div className="text-sm font-semibold mb-1" style={{ color: 'rgb(var(--color-text))' }}>🧠 Anthropic</div>
            <div className="font-mono space-y-0.5" style={{ color: 'rgb(var(--color-text-secondary))' }}>
              <div>POST /v1/messages</div>
              <div>model: claude-sonnet-4-6 (default)</div>
              <div>max_tokens: 8192</div>
              <div>anthropic-version: 2023-06-01</div>
              <div>timeout: 120s</div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Why Verbose Prompting ────────────────────────────── */}
      <Section icon={Key} title="Why the prompt is huge (and why that's correct for small LLMs)" accent="emerald" defaultOpen={false}>
        <div className="text-sm space-y-3" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <p className="text-sm leading-relaxed">
            <strong style={{ color: 'rgb(var(--color-text))' }}>Counterintuitive rule:</strong> for small local
            models (Qwen 7–14B, llama3.1:8b, phi-4, granite-3), <em>more prompting is cheaper than less prompting</em>.
            A short vague prompt causes the model to guess, wander, retry, and invent. A long prompt with concrete
            rules and worked examples produces the right JSON in one pass.
          </p>

          <h3 className="text-sm font-semibold mt-3" style={{ color: 'rgb(var(--color-text))' }}>
            The math of verbose prompts
          </h3>
          <p>
            Short prompt (100 tokens): model produces wrong output. We retry with error feedback — 2nd pass costs
            ~5000 input + ~5000 output = <strong>10,000 wasted tokens</strong>. Often needs a 3rd pass.
          </p>
          <p>
            Long prompt (3000 tokens): model produces correct output. Total spend: ~3000 + ~4000 input + ~2000
            output = <strong>~9000 tokens, one pass, done</strong>. Plus it's faster because no retry latency.
          </p>

          <h3 className="text-sm font-semibold mt-3" style={{ color: 'rgb(var(--color-text))' }}>
            What's in our ~3000-token system prompt
          </h3>
          <ul className="list-disc pl-5 space-y-1">
            <li>Output schema with every required key explicitly shown</li>
            <li>Inclusion/exclusion rules for endpoints (GET list vs singleton vs write)</li>
            <li>Auth detection decision tree (5 branches)</li>
            <li>Pagination detection table (7 styles with explicit clue keywords)</li>
            <li>JSONPath inference table (8 wrapper patterns)</li>
            <li>Primary key priority rules (including composite PKs for OData/ERP)</li>
            <li><strong>8 worked examples</strong>: HubSpot, GitHub, Mailchimp, Frankfurter, Dynamics 365, Stripe, Shopify, Salesforce</li>
            <li>11 "WRONG vs RIGHT" failure-mode patterns (real errors we observed)</li>
            <li>10 edge cases (GraphQL, SOAP, versioned paths, multiple auth, etc.)</li>
          </ul>

          <h3 className="text-sm font-semibold mt-3" style={{ color: 'rgb(var(--color-text))' }}>
            Per-provider runtime tuning
          </h3>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Qwen3 <code>/no_think</code> suffix</strong> — Qwen3 emits a
              <code>&lt;think&gt;...&lt;/think&gt;</code> block by default (often 3000+ reasoning tokens).
              Appending <code>/no_think</code> disables it. The server also strips stray
              <code>&lt;think&gt;</code> blocks from responses.
            </li>
            <li>
              <strong>Ollama <code>format: "json"</code></strong> — constrains decoding to valid JSON tokens.
              No prose, no apologies, no fences.
            </li>
            <li>
              <strong><code>num_ctx: 8192</code></strong> — Q4_K_M quantized models slow down non-linearly past 8k
              context. 8192 is the sweet spot for Qwen and Llama.
            </li>
            <li>
              <strong><code>num_predict: 4096</code></strong> — hard ceiling on output. Prevents runaway loops.
              Plenty for configs with up to ~50 streams.
            </li>
            <li>
              <strong><code>temperature: 0.1</code>, <code>top_p: 0.9</code></strong> — deterministic enough for
              structured JSON, few retries.
            </li>
            <li>
              <strong><code>keep_alive: 5m</code></strong> — keeps the model resident between calls. Cold start
              is paid once.
            </li>
            <li>
              <strong>Input truncation at 16k chars</strong> — prevents prompt_eval_count from blowing past 4k on
              small models.
            </li>
            <li>
              <strong>Deterministic first, LLM last</strong> — valid OpenAPI specs never hit the LLM. The Java
              engine parses them directly. This cuts token use to zero for 90% of real workflows.
            </li>
          </ul>

          <div className="p-3 rounded-xl border-2 mt-4"
               style={{ borderColor: 'rgb(var(--color-border))', background: 'rgb(var(--color-surface-alt))' }}>
            <div className="text-xs font-semibold mb-2" style={{ color: 'rgb(var(--color-text))' }}>
              Recommended small-LLM models for this workload
            </div>
            <ul className="text-xs space-y-1 font-mono">
              <li><strong>qwen3:14b</strong> — sweet spot when you have 24GB VRAM. Very reliable JSON output.</li>
              <li><strong>qwen3:8b</strong> — best balance. &lt;15s per scan on 16GB GPU. Default recommended.</li>
              <li><strong>qwen2.5:7b</strong> — faster cold start. Works for well-structured specs.</li>
              <li><strong>phi4:14b</strong> — strong reasoning on decision tables; slightly slower.</li>
              <li><strong>llama3.1:8b</strong> — good fallback if Qwen isn't available.</li>
              <li><strong>granite-3:8b</strong> — IBM's model, works well with the failure-mode examples.</li>
              <li>Avoid qwen3:0.6b / 1.7b for this task — schema recall is too noisy on complex specs.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── Troubleshooting ──────────────────────────────────── */}
      <Section icon={Server} title="Troubleshooting" accent="amber" defaultOpen={false}>
        <div className="text-sm space-y-3" style={{ color: 'rgb(var(--color-text-secondary))' }}>
          <div>
            <div className="font-semibold" style={{ color: 'rgb(var(--color-text))' }}>Dashboard shows Engine Offline</div>
            <p>Java engine isn't running. Start it with <code>cd engine &amp;&amp; mvn spring-boot:run</code> — listens on port 8081.</p>
          </div>
          <div>
            <div className="font-semibold" style={{ color: 'rgb(var(--color-text))' }}>"No GET endpoints found" from AI</div>
            <p>The content was too short or didn't describe a REST API. Paste the full OpenAPI spec or give it a URL to a docs page with endpoints.</p>
          </div>
          <div>
            <div className="font-semibold" style={{ color: 'rgb(var(--color-text))' }}>"Invalid API key" for OpenAI/Anthropic</div>
            <p>Set the key in <strong>Settings → AI Provider</strong> and click <strong>Test Connection</strong>. Settings persist to disk at <code>app/server/data/ai-settings.json</code>.</p>
          </div>
          <div>
            <div className="font-semibold" style={{ color: 'rgb(var(--color-text))' }}>"Cannot connect" for Ollama</div>
            <p>Start Ollama with <code>ollama serve</code>. The default base URL is <code>http://localhost:11434</code>.</p>
          </div>
          <div>
            <div className="font-semibold" style={{ color: 'rgb(var(--color-text))' }}>Export returns 500 "no jobs"</div>
            <p>The selected jobs no longer have a parent project (deleted). Delete the orphaned jobs in the Jobs page.</p>
          </div>
        </div>
      </Section>
    </div>
  );
}
