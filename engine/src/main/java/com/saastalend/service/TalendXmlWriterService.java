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

    /**
     * Generates the .properties XML for a Talend job.
     *
     * Talend Studio's importer is strict about XMI cross-references:
     *   - ProcessItem.property MUST resolve to Property.xmi:id
     *   - ProcessItem.state    MUST resolve to ItemState.xmi:id
     *   - author.href ../talend.project#X MUST resolve to Project.xmi:id
     *   - additionalProperties.value MUST equal Project.technicalLabel
     *
     * IMPORTANT: dom4j's addAttribute(String,...) and addAttribute(QName,...)
     * collide on local-name "id" — calling both leaves only the second one.
     * We use unique attribute names so that doesn't happen, and we accept the
     * project xmi:id from the caller so the cross-file reference resolves.
     */
    public String writePropertiesXml(TalendJob job, String projectTechLabel,
                                     String projectXmiId) {
        Document document = DocumentHelper.createDocument();

        Namespace xmiNs = new Namespace("xmi", XMI_NS);
        Namespace tpNs = new Namespace("TalendProperties", TALEND_PROPS_NS);

        // Root: xmi:XMI wrapper (required for Talend import)
        Element root = document.addElement(new QName("XMI", xmiNs));
        root.add(tpNs);
        root.addAttribute(new QName("version", xmiNs), "2.0");

        String propId = "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
        String itemStateId = "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
        String processItemId = "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
        // Talend Studio's "human" id for the item — visible in repository as the property id
        String humanId = job.getId() != null ? job.getId() : UUID.randomUUID().toString();

        String now = Instant.now().atOffset(ZoneOffset.UTC)
                .format(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"));

        // Property element — xmi:id is the XMI mechanical id (referenced by ProcessItem.property)
        Element property = root.addElement(new QName("Property", tpNs));
        property.addAttribute(new QName("id", xmiNs), propId);
        property.addAttribute("label", job.getName());
        property.addAttribute("purpose", job.getDescription() != null ? job.getDescription() : "");
        property.addAttribute("description", job.getDescription() != null ? job.getDescription() : "");
        property.addAttribute("creationDate", now);
        property.addAttribute("modificationDate", now);
        property.addAttribute("version", "0.1");
        property.addAttribute("statusCode", "");
        property.addAttribute("item", processItemId);
        property.addAttribute("displayName", job.getName());

        // Author reference — points to the project's xmi:id in talend.project
        Element author = property.addElement("author");
        author.addAttribute("href", "../talend.project#" + projectXmiId);

        // Additional properties
        Element addlProps = property.addElement("additionalProperties");
        addlProps.addAttribute("key", "project.technical.name");
        addlProps.addAttribute("value", projectTechLabel != null ? projectTechLabel : "SAAS_TALEND");

        // ItemState element
        Element itemState = root.addElement(new QName("ItemState", tpNs));
        itemState.addAttribute(new QName("id", xmiNs), itemStateId);
        itemState.addAttribute("path", "");

        // ProcessItem element (links property → item file)
        Element processItem = root.addElement(new QName("ProcessItem", tpNs));
        processItem.addAttribute(new QName("id", xmiNs), processItemId);
        processItem.addAttribute("property", propId);
        processItem.addAttribute("state", itemStateId);

        Element processRef = processItem.addElement("process");
        processRef.addAttribute("href", job.getName() + "_0.1.item#/");

        return formatXml(document);
    }

    /**
     * Holds the talend.project XML plus the project's xmi:id so callers
     * (e.g. WorkspaceExporterService) can wire properties files'
     * author href to the same project ID.
     */
    public static class ProjectXml {
        public final String xml;
        public final String projectXmiId;
        public final String technicalLabel;

        public ProjectXml(String xml, String projectXmiId, String technicalLabel) {
            this.xml = xml;
            this.projectXmiId = projectXmiId;
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
     * Generates the talend.project XML for a Talend workspace.
     * Returns the XML body plus the generated project xmi:id and technical label
     * so other writers can produce coherent cross-references.
     */
    public ProjectXml writeTalendProjectXmlWithId(String projectName) {
        Document document = DocumentHelper.createDocument();

        Namespace xmiNs = new Namespace("xmi", XMI_NS);
        Namespace tpNs = new Namespace("TalendProperties", TALEND_PROPS_NS);

        // Root: xmi:XMI wrapper
        Element root = document.addElement(new QName("XMI", xmiNs));
        root.add(tpNs);
        root.addAttribute(new QName("version", xmiNs), "2.0");

        String projectXmiId = "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);

        String now = Instant.now().atOffset(ZoneOffset.UTC)
                .format(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"));

        String techLabel = projectName.toUpperCase().replaceAll("[^A-Z0-9_]", "_");

        Element project = root.addElement(new QName("Project", tpNs));
        project.addAttribute(new QName("id", xmiNs), projectXmiId);
        project.addAttribute("technicalLabel", techLabel);
        project.addAttribute("label", projectName);
        project.addAttribute("description", "Generated by SaaS to Talend Engine");
        project.addAttribute("language", "java");
        project.addAttribute("productVersion", "8.0.1");
        project.addAttribute("creationDate", now);
        project.addAttribute("migrated", "true");
        project.addAttribute("masterJobId", "");

        // Technical status list (required for import)
        Element techStatus = project.addElement("technicalStatus");
        techStatus.addAttribute("code", "DEV");
        techStatus.addAttribute("label", "development");

        Element techStatus2 = project.addElement("technicalStatus");
        techStatus2.addAttribute("code", "PROD");
        techStatus2.addAttribute("label", "production");

        Element techStatus3 = project.addElement("technicalStatus");
        techStatus3.addAttribute("code", "TEST");
        techStatus3.addAttribute("label", "testing");

        // Component setting (required folder list)
        for (String folder : new String[]{
                "process", "context", "code/routines", "code/routines/system",
                "metadata/connections", "metadata/file", "metadata/sapconnections",
                "metadata/header_footer"}) {
            Element folderEl = project.addElement("folders");
            folderEl.addAttribute("label", folder);
            folderEl.addAttribute("type", "FOLDER");
        }

        return new ProjectXml(formatXml(document), projectXmiId, techLabel);
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
