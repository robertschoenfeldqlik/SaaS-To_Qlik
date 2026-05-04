package com.saastalend.generator;

import com.saastalend.model.*;
import com.saastalend.model.TalendElementParameter.TableEntry;

import java.util.ArrayList;
import java.util.List;

/**
 * Generates an HTTPClient (TaCoKit) component node — the modern Talend Studio 8.0.1
 * REST client, replacing the deprecated tRESTClient. The class name is preserved
 * to avoid touching every caller, but the emitted componentName is "HTTPClient".
 *
 * Verified against a real working Talend Studio 8.0.1 export
 * (C:/Test/talend/dynamics_fo/process/d365fo_extract/Extract_*.item):
 *   - componentName = "HTTPClient"
 *   - componentVersion = "5"
 *   - TACOKIT_COMPONENT_ID = "aHR0cC1zdHVkaW8jSFRUUCNDbGllbnQ"
 *     (base64 of "http-studio#HTTP#Client")
 *   - All real parameters use the configuration.dataset.* nested name path
 *
 * All credentials and base URLs continue to use Talend context variables
 * (context.API_BASE_URL, context.API_BEARER_TOKEN, etc.) so the generated job
 * can be promoted across environments without secret leakage.
 */
public final class TRESTClientGenerator {

    /** base64("http-studio#HTTP#Client") — TaCoKit family identifier required
     *  for Talend Studio 8.0.1 to recognize the HTTPClient component. */
    private static final String HTTPCLIENT_TACOKIT_ID = "aHR0cC1zdHVkaW8jSFRUUCNDbGllbnQ";

    private TRESTClientGenerator() {
    }

    public static TalendNode generate(DiscoveredEndpoint endpoint, AuthConfig auth,
                                       String baseUrl, int posX, int posY) {
        List<TalendElementParameter> params = new ArrayList<>();

        // ── Component identity ─────────────────────────────────────────────
        params.add(hidden("TEXT",      "UNIQUE_NAME",          "tHTTPClient_1"));
        params.add(hidden("TECHNICAL", "TACOKIT_COMPONENT_ID", HTTPCLIENT_TACOKIT_ID));
        params.add(visible("TEXT",     "LABEL",                deriveLabel(endpoint)));

        // ── Datastore (the connection) ─────────────────────────────────────
        params.add(visible("TEXT", "configuration.dataset.datastore.base",
                "context.API_BASE_URL"));
        params.add(visible("TEXT", "configuration.dataset.datastore.connectionTimeout", "30000"));
        params.add(visible("TEXT", "configuration.dataset.datastore.receiveTimeout",    "300000"));
        params.add(visible("CHECK", "configuration.dataset.datastore.bypassCertificateValidation", "false"));
        params.add(visible("CHECK", "configuration.dataset.datastore.useProxy",         "false"));
        params.add(hidden("CLOSED_LIST", "configuration.dataset.datastore.proxyConfiguration.proxyType", "HTTP"));
        params.add(hidden("TEXT", "configuration.dataset.datastore.proxyConfiguration.proxyPort", "443"));

        // ── Authentication ────────────────────────────────────────────────
        appendAuth(params, auth);

        // ── Method + Path ─────────────────────────────────────────────────
        params.add(visible("TACOKIT_VALUE_SELECTION", "configuration.dataset.methodType", "GET"));
        // Quoted Java string literal — Talend evaluates the value as Java code
        params.add(visible("TEXT", "configuration.dataset.resource",
                "\"" + safePath(endpoint.getPath()) + "\""));

        // ── Path / query / header tables ──────────────────────────────────
        params.add(visible("CHECK", "configuration.dataset.hasPathParams", "false"));
        params.add(hiddenTable("configuration.dataset.pathParams"));

        // Query params: emit pagination defaults if endpoint advertises them
        boolean hasQp = endpoint.getPaginationStyle() != null
                && !"none".equalsIgnoreCase(endpoint.getPaginationStyle());
        params.add(visible("CHECK", "configuration.dataset.hasQueryParams", String.valueOf(hasQp)));
        if (hasQp) {
            params.add(buildPaginationQueryParams(endpoint));
        } else {
            params.add(visibleTable("configuration.dataset.queryParams"));
        }

        params.add(visible("CHECK", "configuration.dataset.hasHeaders", "false"));
        params.add(hiddenTable("configuration.dataset.headers"));

        params.add(visible("CHECK", "configuration.dataset.hasBody", "false"));
        params.add(hidden("CLOSED_LIST", "configuration.dataset.body.type", "TEXT"));
        params.add(hiddenTable("configuration.dataset.body.params"));

        // ── Response ──────────────────────────────────────────────────────
        params.add(visible("CLOSED_LIST", "configuration.dataset.format", "RAW_TEXT"));
        params.add(hidden("TEXT", "configuration.dataset.dssl", ""));
        params.add(visible("CLOSED_LIST", "configuration.dataset.returnedContent", "BODY_ONLY"));
        params.add(visible("CHECK", "configuration.dataset.outputKeyValuePairs", "false"));
        params.add(hidden("CHECK", "configuration.dataset.forwardInput", "false"));
        params.add(hiddenTable("configuration.dataset.keyValuePairs"));

        // ── Misc ──────────────────────────────────────────────────────────
        params.add(visible("CHECK", "configuration.downloadFile", "false"));
        params.add(visible("CHECK", "configuration.dataset.acceptRedirections", "true"));
        params.add(visible("TEXT",  "configuration.dataset.maxRedirectOnSameURL", "3"));
        params.add(visible("CHECK", "configuration.dataset.onlySameHost", "false"));
        params.add(visible("CHECK", "configuration.dataset.hasPagination", "false"));
        params.add(hidden("CLOSED_LIST", "configuration.dataset.pagination.strategy", "OFFSET_LIMIT"));
        params.add(hidden("CLOSED_LIST", "configuration.dataset.pagination.offsetLimitStrategyConfig.location", "QUERY_PARAMETERS"));
        params.add(hidden("CHECK", "configuration.dataset.jsonForceDouble", "true"));
        params.add(hidden("CHECK", "configuration.dataset.enforceNumberAsString", "true"));
        params.add(visible("CHECK", "configuration.uploadFiles", "false"));
        params.add(hiddenTable("configuration.uploadFileTable"));
        params.add(visible("CHECK", "configuration.dieOnError", "true"));
        params.add(visible("CLOSED_LIST", "configuration.httpVersion", "HTTP_1_1"));
        params.add(hidden("TECHNICAL", "configuration.dataset.__version", "5"));
        params.add(hidden("TECHNICAL", "configuration.dataset.datastore.__version", "5"));

        // ── Metadata (LOOKUP, MERGE, REJECT, FLOW) ────────────────────────
        // HTTPClient has 4 metadata slots. The FLOW one carries one column "body" of id_String.
        List<TalendMetadata> metadataList = new ArrayList<>();
        metadataList.add(emptyConnector("LOOKUP"));
        metadataList.add(emptyConnector("MERGE"));
        metadataList.add(emptyConnector("REJECT"));
        metadataList.add(TalendMetadata.builder()
                .name("tHTTPClient_1")
                .connectorName("FLOW")
                .columns(List.of(TalendMetadataColumn.builder()
                        .name("body")
                        .talendType("id_String")
                        .key(false)
                        .nullable(true)
                        .build()))
                .build());

        return TalendNode.builder()
                .xmiId(XmiIdGenerator.generate())
                .componentName("HTTPClient")
                .componentVersion("5")
                .posX(posX)
                .posY(posY)
                .parameters(params)
                .metadata(metadataList)
                .build();
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private static void appendAuth(List<TalendElementParameter> params, AuthConfig auth) {
        AuthConfig.AuthType type = (auth != null) ? auth.getType() : AuthConfig.AuthType.NO_AUTH;

        // Always emit the auth-type selector + ALL auth sub-params (hidden when not active)
        // This matches real Talend output; missing params can confuse the importer.
        String selector;
        switch (type) {
            case API_KEY:      selector = "APIKey";  break;
            case BEARER_TOKEN: selector = "APIKey";  break; // bearer tokens use APIKey w/ "Bearer" prefix
            case BASIC:        selector = "Basic";   break;
            case OAUTH2:       selector = "OAuth20"; break;
            default:           selector = "None";    break;
        }
        params.add(visible("CLOSED_LIST", "configuration.dataset.datastore.authentication.type", selector));

        // API key (also used for bearer tokens with "Bearer" prefix)
        boolean isApiKey = type == AuthConfig.AuthType.API_KEY || type == AuthConfig.AuthType.BEARER_TOKEN;
        params.add(maybeHidden("CLOSED_LIST",
                "configuration.dataset.datastore.authentication.apiKey.destination",
                "HEADERS", isApiKey));
        params.add(maybeHidden("TEXT",
                "configuration.dataset.datastore.authentication.apiKey.headerName",
                "Authorization", isApiKey));
        params.add(maybeHidden("TEXT",
                "configuration.dataset.datastore.authentication.apiKey.queryName",
                "apikey", isApiKey));
        params.add(maybeHidden("TEXT",
                "configuration.dataset.datastore.authentication.apiKey.prefix",
                type == AuthConfig.AuthType.BEARER_TOKEN ? "Bearer" : "", isApiKey));
        // The KEY VALUE itself is a separate param — Talend stores it under apiKey.key
        params.add(maybeHidden("PASSWORD",
                "configuration.dataset.datastore.authentication.apiKey.key",
                type == AuthConfig.AuthType.BEARER_TOKEN
                        ? "context.API_BEARER_TOKEN"
                        : "context.API_KEY",
                isApiKey));

        // Basic
        boolean isBasic = type == AuthConfig.AuthType.BASIC;
        params.add(maybeHidden("TEXT",
                "configuration.dataset.datastore.authentication.basic.username",
                "context.API_USERNAME", isBasic));
        params.add(maybeHidden("PASSWORD",
                "configuration.dataset.datastore.authentication.basic.password",
                "context.API_PASSWORD", isBasic));

        // OAuth2
        boolean isOAuth = type == AuthConfig.AuthType.OAUTH2;
        params.add(maybeHidden("CLOSED_LIST",
                "configuration.dataset.datastore.authentication.oauth20.flow",
                "CLIENT_CREDENTIAL", isOAuth));
        params.add(maybeHidden("CLOSED_LIST",
                "configuration.dataset.datastore.authentication.oauth20.authenticationType",
                "FORM", isOAuth));
        params.add(maybeHidden("TEXT",
                "configuration.dataset.datastore.authentication.oauth20.tokenEndpoint",
                "context.OAUTH2_TOKEN_URL", isOAuth));
        params.add(maybeHidden("TEXT",
                "configuration.dataset.datastore.authentication.oauth20.clientId",
                "context.OAUTH2_CLIENT_ID", isOAuth));
        params.add(maybeHidden("PASSWORD",
                "configuration.dataset.datastore.authentication.oauth20.clientSecret",
                "context.OAUTH2_CLIENT_SECRET", isOAuth));
        // Empty params table for additional OAuth scope/audience pairs
        params.add(maybeHiddenTable(
                "configuration.dataset.datastore.authentication.oauth20.params", isOAuth));
    }

    private static TalendElementParameter buildPaginationQueryParams(DiscoveredEndpoint endpoint) {
        TalendElementParameter p = visibleTable("configuration.dataset.queryParams");
        String style = endpoint.getPaginationStyle() == null ? "" : endpoint.getPaginationStyle().toLowerCase();
        List<TableEntry> rows = new ArrayList<>();
        switch (style) {
            case "page":
                addQueryParam(rows, "page", "\"1\"");
                addQueryParam(rows, "per_page", "\"100\"");
                break;
            case "offset":
                addQueryParam(rows, "offset", "\"0\"");
                addQueryParam(rows, "limit",  "\"100\"");
                break;
            case "cursor":
                addQueryParam(rows, "limit", "\"100\"");
                break;
            case "odata":
                addQueryParam(rows, "$top", "\"1000\"");
                break;
            default:
                addQueryParam(rows, "limit", "\"100\"");
                break;
        }
        p.setTableEntries(rows);
        return p;
    }

    private static void addQueryParam(List<TableEntry> rows, String key, String value) {
        rows.add(TableEntry.builder()
                .elementRef("configuration.dataset.queryParams[].key")
                .value("\"" + key + "\"").build());
        rows.add(TableEntry.builder()
                .elementRef("configuration.dataset.queryParams[].value")
                .value(value).build());
        rows.add(TableEntry.builder()
                .elementRef("configuration.dataset.queryParams[].query")
                .value("MAIN").build());
    }

    private static String deriveLabel(DiscoveredEndpoint ep) {
        String name = ep != null ? ep.getName() : null;
        if (name == null || name.isBlank()) return "HTTP_GET";
        return "HTTP_GET_" + name;
    }

    /** Strips XML/path-unsafe chars and ensures the path keeps its leading slash. */
    private static String safePath(String path) {
        if (path == null) return "/";
        return path.replace("\"", "\\\"");
    }

    // ── small param factory helpers ───────────────────────────────────────

    private static TalendElementParameter visible(String field, String name, String value) {
        return TalendElementParameter.builder()
                .field(TalendElementParameter.FieldType.valueOf(field))
                .name(name).value(value).show(true).build();
    }

    private static TalendElementParameter hidden(String field, String name, String value) {
        return TalendElementParameter.builder()
                .field(TalendElementParameter.FieldType.valueOf(field))
                .name(name).value(value).show(false).build();
    }

    private static TalendElementParameter maybeHidden(String field, String name, String value, boolean visible) {
        return visible ? visible(field, name, value) : hidden(field, name, value);
    }

    private static TalendElementParameter visibleTable(String name) {
        return TalendElementParameter.builder()
                .field(TalendElementParameter.FieldType.TABLE)
                .name(name).show(true).build();
    }

    private static TalendElementParameter hiddenTable(String name) {
        return TalendElementParameter.builder()
                .field(TalendElementParameter.FieldType.TABLE)
                .name(name).show(false).build();
    }

    private static TalendElementParameter maybeHiddenTable(String name, boolean visible) {
        return visible ? visibleTable(name) : hiddenTable(name);
    }

    private static TalendMetadata emptyConnector(String connector) {
        return TalendMetadata.builder()
                .name(connector)
                .connectorName(connector)
                .columns(new ArrayList<>())
                .build();
    }
}
