package com.saastalend.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jayway.jsonpath.Configuration;
import com.jayway.jsonpath.JsonPath;
import com.jayway.jsonpath.Option;
import com.saastalend.model.AuthConfig;
import com.saastalend.model.DiscoveredEndpoint;
import com.saastalend.model.FieldInfo;
import com.saastalend.model.ProbeRequest;
import com.saastalend.model.ProbeResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Executes one real HTTP call against a discovered endpoint, applying the
 * provided auth config the same way the generated Talend job will. Used
 * to capture an actual response payload before generation, both as a
 * sanity check ("the API works with these creds") and as a baseline
 * fixture for later regression diffing.
 *
 * Auth handling matches TRESTClientGenerator semantics for the subset
 * of auth types we can resolve at probe time (no OAuth2 token exchange
 * — that requires a client-credentials grant we'd need to set up; for
 * v1 we skip OAuth2 probes).
 */
@Service
public class ProbeService {

    private static final Logger log = LoggerFactory.getLogger(ProbeService.class);

    private final FixtureStore fixtureStore;
    private final RedactionService redactionService;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Configuration jsonPathConfig = Configuration.builder()
            .options(Option.SUPPRESS_EXCEPTIONS, Option.DEFAULT_PATH_LEAF_TO_NULL)
            .build();

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public ProbeService(FixtureStore fixtureStore, RedactionService redactionService) {
        this.fixtureStore = fixtureStore;
        this.redactionService = redactionService;
    }

    public ProbeResponse probe(ProbeRequest req) {
        Instant start = Instant.now();
        ProbeResponse.ProbeResponseBuilder out = ProbeResponse.builder()
                .endpointName(req.getEndpoint() != null ? req.getEndpoint().getName() : "unknown")
                .capturedAt(Instant.now().toString());

        if (req.getEndpoint() == null) {
            return out.error("endpoint is required").build();
        }
        if (req.getBaseUrl() == null || req.getBaseUrl().isBlank()) {
            return out.error("baseUrl is required").build();
        }

        DiscoveredEndpoint ep = req.getEndpoint();
        AuthConfig auth = req.getAuth();

        // ── Build URL: baseUrl + path, with optional auth-injected query params ──
        StringBuilder url = new StringBuilder();
        url.append(req.getBaseUrl().replaceAll("/+$", ""));
        String path = ep.getPath() == null ? "/" : ep.getPath();
        if (!path.startsWith("/")) url.append('/');
        url.append(path);

        List<String> queryParts = new ArrayList<>();
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept", "application/json");
        headers.put("User-Agent", "saas-to-talend-probe/1.0");

        applyAuth(auth, headers, queryParts);

        if (!queryParts.isEmpty()) {
            url.append(path.contains("?") ? '&' : '?');
            url.append(String.join("&", queryParts));
        }
        String finalUrl = url.toString();
        out.url(finalUrl);

        // ── Issue request ─────────────────────────────────────────────────
        HttpRequest.Builder rb = HttpRequest.newBuilder()
                .uri(URI.create(finalUrl))
                .timeout(Duration.ofMillis(Math.max(1000, req.getTimeoutMs())))
                .GET();
        headers.forEach(rb::header);

        HttpResponse<String> resp;
        try {
            resp = http.send(rb.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return out.error("HTTP call failed: " + e.getMessage())
                    .elapsedMs(Duration.between(start, Instant.now()).toMillis())
                    .build();
        }

        long elapsed = Duration.between(start, Instant.now()).toMillis();
        String body = resp.body() == null ? "" : resp.body();
        out.statusCode(resp.statusCode())
                .elapsedMs(elapsed)
                .bodyBytes(body.length());

        // Truncate per request maxBytes so we can never blow up the volume
        long maxBytes = req.getMaxBytes() <= 0 ? Long.MAX_VALUE : req.getMaxBytes();
        if (body.length() > maxBytes) {
            body = body.substring(0, (int) Math.min(maxBytes, Integer.MAX_VALUE));
        }

        // ── Redaction pass: walk the parsed body, scrub PHI/PII values ─────
        // This MUST happen before any persistence or before we put bytes into
        // the response excerpt. Field names + types are preserved so the
        // schema diff still works against future captures.
        String bodyForPersist = body;
        JsonNode parsedRoot = null;
        if (req.isRedact()) {
            try {
                parsedRoot = mapper.readTree(body);
                RedactionService.RedactionReport rep = redactionService.redact(parsedRoot, null);
                if (rep.getRedacted() != null) {
                    parsedRoot = rep.getRedacted();
                    bodyForPersist = mapper.writeValueAsString(parsedRoot);
                }
                out.redacted(true)
                        .redactedCount(rep.getRedactedCount())
                        .redactedKeyPaths(rep.getRedactedKeyPaths());
            } catch (Exception parseFail) {
                // Non-JSON body — can't redact structurally. Fail closed:
                // drop the body to placeholder rather than persisting raw text
                // that might contain PHI (e.g. a stack-trace HTML error page).
                log.info("Body not JSON, applying coarse text redaction");
                bodyForPersist = "[REDACTED-NON-JSON-BODY]";
                out.redacted(true).redactedCount(1);
            }
        } else {
            out.redacted(false);
        }

        if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
            // Still useful — capture the error body so the user can see auth failures, etc.
            out.error("HTTP " + resp.statusCode())
                    .responseExcerpt(excerpt(bodyForPersist, 1024));
            // Save error fixture too — they're often what surfaces auth regressions.
            // We persist bodyForPersist (already redacted if redact=true).
            if (req.isSaveFixture()) {
                trySave(req, bodyForPersist, out);
            }
            return out.build();
        }

        // ── Parse + shape detection via JSONPath (against the REDACTED tree)
        // so the excerpt sent to the UI never carries raw PHI. ────────────
        String recordsPath = ep.getRecordsPath() != null && !ep.getRecordsPath().isBlank()
                ? ep.getRecordsPath()
                : "$";
        try {
            Object resolved = JsonPath
                    .using(jsonPathConfig)
                    .parse(bodyForPersist)  // redacted variant
                    .read(recordsPath);

            JsonNode firstRecord = null;
            int recordCount = 0;

            if (resolved instanceof List<?>) {
                List<?> list = (List<?>) resolved;
                recordCount = list.size();
                if (!list.isEmpty()) {
                    firstRecord = mapper.valueToTree(list.get(0));
                }
            } else if (resolved != null) {
                // Single object — treat as one record
                recordCount = 1;
                firstRecord = mapper.valueToTree(resolved);
            } else {
                recordCount = -1; // path didn't resolve
            }

            out.recordCount(recordCount);
            if (firstRecord != null && firstRecord.isObject()) {
                out.fields(inferFields(firstRecord));
                out.responseExcerpt(excerpt(mapper.writeValueAsString(firstRecord), 2048));
            } else if (firstRecord != null) {
                out.responseExcerpt(excerpt(mapper.writeValueAsString(firstRecord), 1024));
            } else {
                out.responseExcerpt(excerpt(bodyForPersist, 1024));
            }
        } catch (Exception e) {
            log.warn("JSONPath resolve failed for {} : {}", recordsPath, e.getMessage());
            out.recordCount(-1)
                    .responseExcerpt(excerpt(bodyForPersist, 1024));
        }

        // ── Persist the REDACTED body — never the raw bytes when redact=true.
        if (req.isSaveFixture()) {
            trySave(req, bodyForPersist, out);
        }
        return out.build();
    }

    private void trySave(ProbeRequest req, String body, ProbeResponse.ProbeResponseBuilder out) {
        try {
            Path saved = fixtureStore.save(
                    req.getFixtureKey(),
                    req.getEndpoint().getName(),
                    body);
            out.fixturePath(saved.toString());
        } catch (Exception saveErr) {
            log.warn("Failed to save fixture: {}", saveErr.getMessage());
            String existingError = out.build().getError();
            String combined = (existingError == null ? "" : existingError + "; ")
                    + "fixture-save-failed: " + saveErr.getMessage();
            out.error(combined);
        }
    }

    /** Inject auth into headers and/or query params, matching what TRESTClientGenerator emits. */
    private void applyAuth(AuthConfig auth, Map<String, String> headers, List<String> queryParts) {
        if (auth == null || auth.getType() == null) return;

        switch (auth.getType()) {
            case BEARER_TOKEN:
                if (auth.getBearerToken() != null && !auth.getBearerToken().isBlank()) {
                    headers.put("Authorization", "Bearer " + auth.getBearerToken());
                }
                break;

            case API_KEY:
                if (auth.getApiKey() != null && !auth.getApiKey().isBlank()) {
                    String location = auth.getApiKeyLocation();
                    boolean inQuery = location != null && location.equalsIgnoreCase("QUERY");
                    String name = auth.getApiKeyName() != null && !auth.getApiKeyName().isBlank()
                            ? auth.getApiKeyName()
                            : "X-API-Key";
                    if (inQuery) {
                        queryParts.add(URLEncoder.encode(name, StandardCharsets.UTF_8)
                                + "=" + URLEncoder.encode(auth.getApiKey(), StandardCharsets.UTF_8));
                    } else {
                        headers.put(name, auth.getApiKey());
                    }
                }
                break;

            case BASIC:
                if (auth.getUsername() != null && auth.getPassword() != null) {
                    String creds = auth.getUsername() + ":" + auth.getPassword();
                    String enc = Base64.getEncoder().encodeToString(creds.getBytes(StandardCharsets.UTF_8));
                    headers.put("Authorization", "Basic " + enc);
                }
                break;

            case OAUTH2:
                // Probing OAuth2 endpoints requires a token-exchange step we
                // don't run here (would need the client to have already
                // performed a client-credentials flow and provided a token).
                // For now we skip; the user can re-probe later with the
                // resolved access token plugged in as Bearer.
                log.info("Skipping auth header for OAUTH2 probe (no token exchange in v1)");
                break;

            case NO_AUTH:
            default:
                break;
        }
    }

    private List<FieldInfo> inferFields(JsonNode record) {
        List<FieldInfo> fields = new ArrayList<>();
        Iterator<String> names = record.fieldNames();
        while (names.hasNext()) {
            String name = names.next();
            JsonNode value = record.get(name);
            fields.add(FieldInfo.builder()
                    .name(name)
                    .type(jsonNodeToTalendType(value))
                    .build());
        }
        return fields;
    }

    /** Map a Jackson node to the same Talend type tokens TRESTClientGenerator uses. */
    private static String jsonNodeToTalendType(JsonNode n) {
        if (n == null || n.isNull())  return "id_String";
        if (n.isTextual())            return "id_String";
        if (n.isBoolean())            return "id_Boolean";
        if (n.isInt() || n.isLong())  return "id_Long";
        if (n.isFloat() || n.isDouble() || n.isBigDecimal()) return "id_Double";
        if (n.isArray())              return "id_String";   // serialized
        if (n.isObject())             return "id_String";   // serialized
        return "id_String";
    }

    private static String excerpt(String s, int max) {
        if (s == null) return null;
        return s.length() <= max ? s : s.substring(0, max) + "…[truncated]";
    }
}
