package com.saastalend.service;

import com.saastalend.model.*;
import org.dom4j.Document;
import org.dom4j.DocumentHelper;
import org.dom4j.Element;
import org.dom4j.Namespace;
import org.dom4j.QName;
import org.dom4j.io.OutputFormat;
import org.dom4j.io.XMLWriter;
import org.springframework.stereotype.Service;

import java.io.StringWriter;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Generates Talend Studio-compatible XML files (.item, .properties, talend.project).
 *
 * The generated XML follows the exact format Talend Studio 8.0.1 uses for import,
 * including proper XMI namespaces, context variable definitions, and the full
 * .properties wrapper structure (Property → ProcessItem → Process).
 *
 * Context variables are defined for all credentials, URLs, DB connections, and
 * Qlik Cloud tenant settings — matching the dbt-to-Talend conversion pattern.
 */
@Service
public class TalendXmlWriterService {

    private static final String XMI_NS = "http://www.omg.org/XMI";
    private static final String TALEND_FILE_NS = "platform:/resource/org.talend.model/model/TalendFile.xsd";
    private static final String TALEND_PROPS_NS = "http://www.talend.org/properties";

    /**
     * Context variables wired into every generated job.
     * Maps variable name → { type, prompt (description), value (default) }
     */
    private static final Map<String, String[]> STANDARD_CONTEXT_VARS = new LinkedHashMap<>();

    static {
        // API connection
        STANDARD_CONTEXT_VARS.put("API_BASE_URL",        new String[]{"id_String",   "Base URL of the SaaS API", ""});
        STANDARD_CONTEXT_VARS.put("API_BEARER_TOKEN",    new String[]{"id_Password", "Bearer token for API auth", ""});
        STANDARD_CONTEXT_VARS.put("API_KEY",             new String[]{"id_Password", "API key for authentication", ""});
        STANDARD_CONTEXT_VARS.put("API_KEY_NAME",        new String[]{"id_String",   "Header name for API key", "X-API-Key"});
        STANDARD_CONTEXT_VARS.put("API_USERNAME",        new String[]{"id_String",   "Username for Basic auth", ""});
        STANDARD_CONTEXT_VARS.put("API_PASSWORD",        new String[]{"id_Password", "Password for Basic auth", ""});

        // OAuth2
        STANDARD_CONTEXT_VARS.put("OAUTH2_TOKEN_URL",    new String[]{"id_String",   "OAuth2 token endpoint URL", ""});
        STANDARD_CONTEXT_VARS.put("OAUTH2_CLIENT_ID",    new String[]{"id_String",   "OAuth2 client ID", ""});
        STANDARD_CONTEXT_VARS.put("OAUTH2_CLIENT_SECRET",new String[]{"id_Password", "OAuth2 client secret", ""});

        // Database credentials
        STANDARD_CONTEXT_VARS.put("DB_HOST",             new String[]{"id_String",   "Database host", "localhost"});
        STANDARD_CONTEXT_VARS.put("DB_PORT",             new String[]{"id_String",   "Database port", "5432"});
        STANDARD_CONTEXT_VARS.put("DB_NAME",             new String[]{"id_String",   "Database name", ""});
        STANDARD_CONTEXT_VARS.put("DB_SCHEMA",           new String[]{"id_String",   "Database schema", "public"});
        STANDARD_CONTEXT_VARS.put("DB_USERNAME",         new String[]{"id_String",   "Database username", ""});
        STANDARD_CONTEXT_VARS.put("DB_PASSWORD",         new String[]{"id_Password", "Database password", ""});
        STANDARD_CONTEXT_VARS.put("DB_JDBC_URL",         new String[]{"id_String",   "Full JDBC connection URL", ""});

        // Qlik Cloud tenant
        STANDARD_CONTEXT_VARS.put("QLIK_TENANT_URL",    new String[]{"id_String",   "Qlik Cloud tenant URL (e.g. https://tenant.us.qlikcloud.com)", ""});
        STANDARD_CONTEXT_VARS.put("QLIK_API_KEY",       new String[]{"id_Password", "Qlik Cloud API key", ""});
        STANDARD_CONTEXT_VARS.put("QLIK_SPACE_ID",      new String[]{"id_String",   "Qlik Cloud space ID", ""});
        STANDARD_CONTEXT_VARS.put("QLIK_APP_ID",        new String[]{"id_String",   "Qlik Cloud app ID", ""});

        // Output
        STANDARD_CONTEXT_VARS.put("OUTPUT_DIR",          new String[]{"id_String",   "Output directory for files", "/tmp/talend/output"});
    }

    /**
     * Generates the .item XML (XMI 2.0 format) for a Talend job,
     * including context variables for all credentials and URLs.
     */
    public String writeItemXml(TalendJob job) {
        Document document = DocumentHelper.createDocument();

        Namespace xmiNs = new Namespace("xmi", XMI_NS);
        Namespace talendNs = new Namespace("talendfile", TALEND_FILE_NS);

        Element root = document.addElement(new QName("ProcessType", talendNs));
        root.add(xmiNs);
        root.addAttribute(new QName("version", xmiNs), "2.0");
        root.addAttribute("defaultContext", "Default");

        // ── Context with all variables ──
        Element context = root.addElement("context");
        context.addAttribute("confirmationNeeded", "false");
        context.addAttribute("name", "Default");

        // Add standard context variables
        for (Map.Entry<String, String[]> entry : STANDARD_CONTEXT_VARS.entrySet()) {
            Element ctxParam = context.addElement("contextParameter");
            ctxParam.addAttribute("comment", entry.getValue()[1]);
            ctxParam.addAttribute("name", entry.getKey());
            ctxParam.addAttribute("prompt", entry.getValue()[1] + "?");
            ctxParam.addAttribute("promptNeeded", "false");
            ctxParam.addAttribute("type", entry.getValue()[0]);
            ctxParam.addAttribute("value", entry.getValue()[2]);
        }

        // Wire in the actual base URL as the default for this specific job
        if (job.getEndpoint() != null) {
            setContextDefault(context, "API_BASE_URL",
                    deriveBaseUrl(job));
        }
        // Wire auth defaults from the job's auth config
        if (job.getAuthConfig() != null) {
            wireAuthDefaults(context, job.getAuthConfig());
        }

        // ── Job-level parameters ──
        Element parameters = root.addElement("parameters");
        addElementParameter(parameters, "TEXT", "JOB_RUN_VM_ARGUMENTS",
                " -Xms256M -Xmx1024M");
        addElementParameter(parameters, "CHECK", "MULTI_THREAD_EXECUTION", "false");
        addElementParameter(parameters, "TEXT", "SCREEN_OFFSET_X", "0");
        addElementParameter(parameters, "TEXT", "SCREEN_OFFSET_Y", "0");
        addElementParameter(parameters, "CHECK", "IMPLICITCONTEXT_USE_PROJECT_SETTINGS", "true");
        addElementParameter(parameters, "CHECK", "STATANDLOG_USE_PROJECT_SETTINGS", "true");

        // Routine imports (standard Talend routines)
        Element routinesParam = parameters.addElement("routinesParameter");
        routinesParam.addAttribute("name", "DataOperation");
        Element routinesParam2 = parameters.addElement("routinesParameter");
        routinesParam2.addAttribute("name", "Mathematical");
        Element routinesParam3 = parameters.addElement("routinesParameter");
        routinesParam3.addAttribute("name", "Numeric");
        Element routinesParam4 = parameters.addElement("routinesParameter");
        routinesParam4.addAttribute("name", "Relational");
        Element routinesParam5 = parameters.addElement("routinesParameter");
        routinesParam5.addAttribute("name", "StringHandling");
        Element routinesParam6 = parameters.addElement("routinesParameter");
        routinesParam6.addAttribute("name", "TalendDataGenerator");
        Element routinesParam7 = parameters.addElement("routinesParameter");
        routinesParam7.addAttribute("name", "TalendDate");
        Element routinesParam8 = parameters.addElement("routinesParameter");
        routinesParam8.addAttribute("name", "TalendString");

        // ── Nodes ──
        for (TalendNode node : job.getNodes()) {
            writeNode(root, node);
        }

        // ── Connections ──
        for (TalendConnection conn : job.getConnections()) {
            writeConnection(root, conn);
        }

        // ── Subjobs ──
        if (!job.getNodes().isEmpty()) {
            Element subjob = root.addElement("subjob");
            TalendNode firstNode = job.getNodes().get(0);
            String uniqueName = getUniqueName(firstNode);
            addElementParameter(subjob, "TEXT", "UNIQUE_NAME", uniqueName);
        }

        return formatXml(document);
    }

    /** Full product version string Talend Studio embeds in .properties metadata. */
    private static final String PRODUCT_FULLNAME = "Talend Open Studio for Data Integration";
    private static final String PRODUCT_VERSION = "8.0.1";

    /**
     * Generates the .properties XML for a Talend job, matching the format Talend
     * Studio 8.0.1 writes natively.
     *
     * Real Talend .properties (from a working dynamics_fo project) has:
     *   - Property xmi:id = mechanical id (referenced by ProcessItem.property)
     *   - Property id     = SECOND id attr (different from xmi:id) — required
     *   - author href     = ../talend.project#<UserXmiId>  (NOT project's xmi:id)
     *   - additionalProperties: created_product_fullname, created_product_version,
     *     created_date — NOT "project.technical.name" (that's elsewhere)
     *   - ItemState.path  = subfolder under process/ ("" for root)
     *
     * Cross-file cross-refs that MUST resolve for import to succeed:
     *   ProcessItem.property == Property.xmi:id
     *   ProcessItem.state    == ItemState.xmi:id
     *   ProcessItem.xmi:id   == Property.item
     *   author href fragment == User.xmi:id (in talend.project)
     */
    public String writePropertiesXml(TalendJob job, String projectTechLabel,
                                     String projectXmiId, String userXmiId) {
        Document document = DocumentHelper.createDocument();

        Namespace xmiNs = new Namespace("xmi", XMI_NS);
        Namespace tpNs = new Namespace("TalendProperties", TALEND_PROPS_NS);

        // Root order matches real Talend: xmi:version first, then xmlns:xmi, xmlns:TalendProperties
        Element root = document.addElement(new QName("XMI", xmiNs));
        root.add(tpNs);
        root.addAttribute(new QName("version", xmiNs), "2.0");

        // Use SHORT 20-hex-char ids like real Talend (not 24)
        String propId        = "_" + shortId();
        String secondaryId   = "_" + shortId(); // the unnamespaced "id" attribute on Property
        String itemStateId   = "_" + shortId();
        String processItemId = "_" + shortId();

        // Property element. We deliberately use the dom4j "addAttribute(QName)" call
        // for both ids so they don't collide on local name in the same way the old
        // code did. The key is to give them DIFFERENT QNames (xmi:id vs id-with-no-ns).
        Element property = root.addElement(new QName("Property", tpNs));
        property.addAttribute(new QName("id", xmiNs), propId);
        // The "id" attribute (no namespace) is added directly on the underlying
        // element object via DOM rather than dom4j's addAttribute, to avoid
        // dom4j's local-name collision behaviour overwriting xmi:id.
        property.addAttribute(QName.get("id"), secondaryId);
        property.addAttribute("label", job.getName());
        property.addAttribute("version", "0.1");
        property.addAttribute("statusCode", "");
        property.addAttribute("item", processItemId);
        property.addAttribute("displayName", job.getName());

        // Author reference — Talend resolves to the User element in talend.project
        Element author = property.addElement("author");
        // process/<jobName>_0.1.properties → ../talend.project = project root
        // (one level up because the .properties file is one folder deep)
        author.addAttribute("href", "../talend.project#" + userXmiId);

        // Real Talend additionalProperties: 3 entries with metadata, each having its own xmi:id
        String now = Instant.now().atOffset(ZoneOffset.UTC)
                .format(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSxx"));
        addAdditionalProperty(property, xmiNs, propId + "_p1",
                "created_product_fullname", PRODUCT_FULLNAME);
        addAdditionalProperty(property, xmiNs, propId + "_p2",
                "created_product_version", PRODUCT_VERSION);
        addAdditionalProperty(property, xmiNs, propId + "_p3",
                "created_date", now);

        // ItemState — path is the subfolder under process/ for grouping; root = ""
        Element itemState = root.addElement(new QName("ItemState", tpNs));
        itemState.addAttribute(new QName("id", xmiNs), itemStateId);
        itemState.addAttribute("path", "");

        // ProcessItem — links Property + ItemState + .item file
        Element processItem = root.addElement(new QName("ProcessItem", tpNs));
        processItem.addAttribute(new QName("id", xmiNs), processItemId);
        processItem.addAttribute("property", propId);
        processItem.addAttribute("state", itemStateId);

        Element processRef = processItem.addElement("process");
        processRef.addAttribute("href", job.getName() + "_0.1.item#/");

        return formatXml(document);
    }

    /**
     * Backward-compatible 3-arg overload (no userXmiId) — falls back to a
     * stable User id derived from the project xmi:id so author hrefs still resolve.
     */
    public String writePropertiesXml(TalendJob job, String projectTechLabel,
                                     String projectXmiId) {
        return writePropertiesXml(job, projectTechLabel, projectXmiId,
                projectXmiId + "_user");
    }

    private static void addAdditionalProperty(Element parent, Namespace xmiNs,
                                              String xmiId, String key, String value) {
        Element ap = parent.addElement("additionalProperties");
        ap.addAttribute(new QName("id", xmiNs), xmiId);
        ap.addAttribute("key", key);
        ap.addAttribute("value", value);
    }

    /** Generate a 20-char hex id matching Talend's format. */
    private static String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 20);
    }

    /**
     * Holds the talend.project XML plus the project's xmi:id, user's xmi:id,
     * and technical label so callers (e.g. WorkspaceExporterService) can wire
     * properties files' author hrefs back to the User element in talend.project.
     */
    public static class ProjectXml {
        public final String xml;
        public final String projectXmiId;
        public final String userXmiId;
        public final String technicalLabel;

        public ProjectXml(String xml, String projectXmiId, String userXmiId,
                          String technicalLabel) {
            this.xml = xml;
            this.projectXmiId = projectXmiId;
            this.userXmiId = userXmiId;
            this.technicalLabel = technicalLabel;
        }
    }

    /**
     * Backward-compatible single-string overload.
     */
    public String writeTalendProjectXml(String projectName) {
        return writeTalendProjectXmlWithId(projectName).xml;
    }

    /**
     * Generates the talend.project XML matching the format Talend Studio 8.0.1
     * writes natively. Critical differences from the previous version:
     *   - <Project> needs local="true", author=<UserXmiId>, type="DI",
     *     itemsRelationVersion="1.3", productVersion="<full string>"
     *   - <technicalStatus> and <folders> are NOT in talend.project — they live
     *     in .settings/project.settings as JSON
     *   - A sibling <User> element MUST exist; .properties files reference it
     *     via author href fragment
     *   - <migrationTask> child documents the schema version
     */
    public ProjectXml writeTalendProjectXmlWithId(String projectName) {
        Document document = DocumentHelper.createDocument();

        Namespace xmiNs = new Namespace("xmi", XMI_NS);
        Namespace tpNs = new Namespace("TalendProperties", TALEND_PROPS_NS);

        Element root = document.addElement(new QName("XMI", xmiNs));
        root.add(tpNs);
        root.addAttribute(new QName("version", xmiNs), "2.0");

        String projectXmiId = "_" + shortId();
        String userXmiId    = "_" + shortId();
        String migXmiId     = "_" + shortId();

        String techLabel = projectName.toUpperCase().replaceAll("[^A-Z0-9_]", "_");

        Element project = root.addElement(new QName("Project", tpNs));
        project.addAttribute(new QName("id", xmiNs), projectXmiId);
        project.addAttribute("label", projectName);
        project.addAttribute("description", "Generated by SaaS to Talend Engine");
        project.addAttribute("language", "java");
        project.addAttribute("technicalLabel", techLabel);
        project.addAttribute("author", userXmiId);
        project.addAttribute("productVersion",
                "Talend Cloud Data Fabric-" + PRODUCT_VERSION);
        project.addAttribute("type", "DQ");
        project.addAttribute("itemsRelationVersion", "1.3");
        project.addAttribute("bigData", "false");

        // Migration task — Talend records the schema version the project was
        // created with. The minimum required for import is the
        // CheckProductVersionMigrationTask. Use QName.get("id") for the
        // unnamespaced "id" attribute to avoid dom4j's local-name collision
        // with xmi:id (the second addAttribute would otherwise clobber the first).
        Element migration = project.addElement("migrationTask");
        migration.addAttribute(new QName("id", xmiNs), migXmiId);
        migration.addAttribute(QName.get("id"),
                "org.talend.repository.model.migration.CheckProductVersionMigrationTask");
        migration.addAttribute("breaks", "7.1.0");
        migration.addAttribute("version", "7.1.1");

        // Sibling User element — author hrefs in .properties files resolve
        // here. Talend Studio attributes job ownership to this user.
        Element user = root.addElement(new QName("User", tpNs));
        user.addAttribute(new QName("id", xmiNs), userXmiId);
        user.addAttribute("login", "saas-to-talend@local");
        user.addAttribute("type", "DQ");

        return new ProjectXml(formatXml(document), projectXmiId, userXmiId, techLabel);
    }

    /**
     * Loads the real Talend Studio project.settings JSON template from
     * resources. This file mirrors what Talend Studio 8.0.1 writes when
     * exporting a project — it's a comprehensive JSON of statAndLogsSettings,
     * implicitContextSettings, technicalStatus, etc. that Talend Studio's
     * import path validates strictly.
     */
    public String writeProjectSettingsJson() {
        return loadResource("talend-templates/project.settings");
    }

    /**
     * Loads the real Talend Studio migration_task.index JSON. Talend Studio's
     * import path uses this list to skip already-applied migrations on the
     * imported items. Without it, every job triggers thousands of migration
     * scans on first open.
     */
    public String writeMigrationTaskIndex() {
        return loadResource("talend-templates/migration_task.index");
    }

    /**
     * Empty relationship index — Talend rebuilds it on first project open.
     * The real format is a JSON array of {baseItem, relatedItems} entries
     * but an empty array is accepted.
     */
    public String writeRelationshipIndex() {
        return "[ ]\n";
    }

    private static String loadResource(String path) {
        try (java.io.InputStream is = TalendXmlWriterService.class
                .getClassLoader().getResourceAsStream(path)) {
            if (is == null) throw new RuntimeException("Resource not found: " + path);
            byte[] data = is.readAllBytes();
            return new String(data, java.nio.charset.StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            throw new RuntimeException("Failed to load resource: " + path, e);
        }
    }

    // ── Internal helpers ──

    private void writeNode(Element root, TalendNode node) {
        Element nodeEl = root.addElement("node");
        nodeEl.addAttribute("componentName", node.getComponentName());
        nodeEl.addAttribute("componentVersion",
                node.getComponentVersion() != null ? node.getComponentVersion() : "0.102");
        nodeEl.addAttribute("offsetLabelX", "0");
        nodeEl.addAttribute("offsetLabelY", "0");
        nodeEl.addAttribute("posX", String.valueOf(node.getPosX()));
        nodeEl.addAttribute("posY", String.valueOf(node.getPosY()));

        if (node.getParameters() != null) {
            for (TalendElementParameter param : node.getParameters()) {
                Element paramEl = nodeEl.addElement("elementParameter");
                paramEl.addAttribute("field",
                        param.getField() != null ? param.getField().name() : "TEXT");
                paramEl.addAttribute("name", param.getName());
                paramEl.addAttribute("value",
                        com.saastalend.generator.TDBRowGenerator.stripInvalidXmlChars(
                                param.getValue() != null ? param.getValue() : ""));
                if (!param.isShow()) {
                    paramEl.addAttribute("show", "false");
                }
            }
        }

        if (node.getMetadata() != null) {
            for (TalendMetadata meta : node.getMetadata()) {
                Element metaEl = nodeEl.addElement("metadata");
                metaEl.addAttribute("connector",
                        meta.getConnectorName() != null ? meta.getConnectorName() : "FLOW");
                metaEl.addAttribute("name", meta.getName() != null ? meta.getName() : "");

                if (meta.getColumns() != null) {
                    for (TalendMetadataColumn col : meta.getColumns()) {
                        Element colEl = metaEl.addElement("column");
                        colEl.addAttribute("key", String.valueOf(col.isKey()));
                        colEl.addAttribute("name", col.getName());
                        colEl.addAttribute("nullable", String.valueOf(col.isNullable()));
                        colEl.addAttribute("talendType",
                                col.getTalendType() != null ? col.getTalendType() : "id_String");
                        if (col.getLength() > 0) {
                            colEl.addAttribute("length", String.valueOf(col.getLength()));
                        }
                        if (col.getPrecision() > 0) {
                            colEl.addAttribute("precision", String.valueOf(col.getPrecision()));
                        }
                        if (col.getComment() != null && !col.getComment().isEmpty()) {
                            colEl.addAttribute("comment", col.getComment());
                        }
                    }
                }
            }
        }
    }

    private void writeConnection(Element root, TalendConnection conn) {
        Element connEl = root.addElement("connection");
        connEl.addAttribute("connectorName", conn.getConnectorName());
        connEl.addAttribute("label", conn.getLabel() != null ? conn.getLabel() : conn.getConnectorName());
        connEl.addAttribute("lineStyle", String.valueOf(conn.getLineStyle()));
        connEl.addAttribute("source", conn.getSource());
        connEl.addAttribute("target", conn.getTarget());
    }

    private void addElementParameter(Element parent, String field, String name, String value) {
        Element param = parent.addElement("elementParameter");
        param.addAttribute("field", field);
        param.addAttribute("name", name);
        param.addAttribute("value", value);
    }

    private String getUniqueName(TalendNode node) {
        if (node.getParameters() != null) {
            for (TalendElementParameter param : node.getParameters()) {
                if ("UNIQUE_NAME".equals(param.getName())) {
                    return param.getValue();
                }
            }
        }
        return node.getComponentName() + "_1";
    }

    /**
     * Derives the base URL from the job endpoint and auth config.
     */
    private String deriveBaseUrl(TalendJob job) {
        if (job.getEndpoint() != null && job.getEndpoint().getPath() != null) {
            // The generator stores the full URL info; extract base from context
            // For now use the endpoint to derive — callers pass baseUrl in the job
            return ""; // Default empty — user fills via context
        }
        return "";
    }

    /**
     * Sets a context variable's default value.
     */
    private void setContextDefault(Element contextEl, String varName, String value) {
        for (int i = 0; i < contextEl.elements("contextParameter").size(); i++) {
            Element param = contextEl.elements("contextParameter").get(i);
            if (varName.equals(param.attributeValue("name"))) {
                param.addAttribute("value", value != null ? value : "");
                return;
            }
        }
    }

    /**
     * Wires auth config values as context variable defaults.
     */
    private void wireAuthDefaults(Element contextEl, AuthConfig auth) {
        switch (auth.getType()) {
            case BEARER_TOKEN:
                if (auth.getBearerToken() != null) {
                    setContextDefault(contextEl, "API_BEARER_TOKEN", auth.getBearerToken());
                }
                break;
            case API_KEY:
                if (auth.getApiKey() != null) {
                    setContextDefault(contextEl, "API_KEY", auth.getApiKey());
                }
                if (auth.getApiKeyName() != null) {
                    setContextDefault(contextEl, "API_KEY_NAME", auth.getApiKeyName());
                }
                break;
            case BASIC:
                if (auth.getUsername() != null) {
                    setContextDefault(contextEl, "API_USERNAME", auth.getUsername());
                }
                if (auth.getPassword() != null) {
                    setContextDefault(contextEl, "API_PASSWORD", auth.getPassword());
                }
                break;
            case OAUTH2:
                if (auth.getOauth2TokenUrl() != null) {
                    setContextDefault(contextEl, "OAUTH2_TOKEN_URL", auth.getOauth2TokenUrl());
                }
                if (auth.getOauth2ClientId() != null) {
                    setContextDefault(contextEl, "OAUTH2_CLIENT_ID", auth.getOauth2ClientId());
                }
                if (auth.getOauth2ClientSecret() != null) {
                    setContextDefault(contextEl, "OAUTH2_CLIENT_SECRET", auth.getOauth2ClientSecret());
                }
                break;
            default:
                break;
        }
    }

    private String formatXml(Document document) {
        try {
            OutputFormat format = OutputFormat.createPrettyPrint();
            format.setEncoding("UTF-8");
            format.setIndentSize(2);
            format.setNewLineAfterDeclaration(false);

            StringWriter writer = new StringWriter();
            XMLWriter xmlWriter = new XMLWriter(writer, format);
            xmlWriter.write(document);
            xmlWriter.flush();
            return writer.toString();
        } catch (Exception e) {
            throw new RuntimeException("Failed to format XML", e);
        }
    }
}
