package com.saastalend.generator;

import com.saastalend.model.*;
import com.saastalend.model.TalendElementParameter.TableEntry;

import java.util.ArrayList;
import java.util.List;

/**
 * Generates a tExtractJSONFields component matching the real Talend Studio 8.0.1
 * output format. Verified against
 * C:/Test/talend/dynamics_fo/process/d365fo_extract/Extract_*.item:
 *
 *   <node componentName="tExtractJSONFields" componentVersion="0.102" ...>
 *     <elementParameter field="CLOSED_LIST"      name="READ_BY"          value="JSONPATH"/>
 *     <elementParameter field="CLOSED_LIST"      name="JSON_PATH_VERSION" value="2_1_0"/>
 *     <elementParameter field="PREV_COLUMN_LIST" name="JSONFIELD"        value="body"/>
 *     <elementParameter field="TEXT"             name="JSON_LOOP_QUERY"  value="&quot;$.value[*]&quot;"/>
 *     <elementParameter field="CHECK"            name="DIE_ON_ERROR"     value="false"/>
 *     <elementParameter field="TABLE"            name="MAPPING">
 *       <elementValue elementRef="SCHEMA_COLUMN" value="..."/>
 *       <elementValue elementRef="QUERY"         value="&quot;...&quot;"/>
 *       <elementValue elementRef="NODECHECK"     value=""/>
 *       <elementValue elementRef="ISARRAY"       value=""/>
 *     </elementParameter>
 *
 * Critically the previous implementation used MAPPING as a JSON-array-string,
 * which Talend's importer silently dropped. The real format is nested
 * elementValue children.
 */
public final class TExtractJSONFieldsGenerator {

    private TExtractJSONFieldsGenerator() {
    }

    public static TalendNode generate(DiscoveredEndpoint endpoint, int posX, int posY) {
        List<TalendElementParameter> params = new ArrayList<>();

        params.add(p("TEXT", "UNIQUE_NAME", "tExtractJSONFields_1", false));
        params.add(p("CLOSED_LIST", "READ_BY", "JSONPATH", true));
        params.add(p("CLOSED_LIST", "JSON_PATH_VERSION", "2_1_0", true));

        // PREV_COLUMN_LIST tells Talend which input column carries the JSON
        // payload — the HTTPClient component upstream emits a "body" column.
        params.add(p("PREV_COLUMN_LIST", "JSONFIELD", "body", true));

        // The JSONPath expression that selects records from the response.
        // Wrapped in Java-string-literal quotes because Talend evaluates it.
        String loopExpr = endpoint.getRecordsPath() != null ? endpoint.getRecordsPath() : "$[*]";
        params.add(p("TEXT", "JSON_LOOP_QUERY", "\"" + loopExpr + "\"", true));
        // LOOP_QUERY is a hidden duplicate Talend keeps for legacy compatibility
        params.add(p("TEXT", "LOOP_QUERY", "\"" + loopExpr + "\"", false));

        params.add(p("CHECK", "DIE_ON_ERROR", "false", true));

        // ── MAPPING table — one row per output column with 4 elementValue cells
        TalendElementParameter mapping = TalendElementParameter.builder()
                .field(TalendElementParameter.FieldType.TABLE)
                .name("MAPPING")
                .show(false)
                .build();
        List<TableEntry> rows = new ArrayList<>();
        if (endpoint.getResponseFields() != null && !endpoint.getResponseFields().isEmpty()) {
            for (FieldInfo field : endpoint.getResponseFields()) {
                String col = sanitizeColumnName(field.getName());
                rows.add(row("SCHEMA_COLUMN", col));
                rows.add(row("QUERY", "\"" + field.getName() + "\""));
                rows.add(row("NODECHECK", ""));
                rows.add(row("ISARRAY", ""));
            }
        } else {
            // Fall back to a single body column so the component still validates
            rows.add(row("SCHEMA_COLUMN", "body"));
            rows.add(row("QUERY", "\".\""));
            rows.add(row("NODECHECK", ""));
            rows.add(row("ISARRAY", ""));
        }
        mapping.setTableEntries(rows);
        params.add(mapping);

        // ── Metadata: FLOW connector named row1 (real Talend default name) ──
        List<TalendMetadataColumn> columns = new ArrayList<>();
        if (endpoint.getResponseFields() != null && !endpoint.getResponseFields().isEmpty()) {
            for (FieldInfo field : endpoint.getResponseFields()) {
                columns.add(TalendMetadataColumn.builder()
                        .name(sanitizeColumnName(field.getName()))
                        .talendType(field.getType() != null ? field.getType() : "id_String")
                        .key(endpoint.getPrimaryKeys() != null
                                && endpoint.getPrimaryKeys().contains(field.getName()))
                        .nullable(true)
                        .comment(field.getDescription())
                        .build());
            }
        } else {
            columns.add(TalendMetadataColumn.builder()
                    .name("body").talendType("id_String").nullable(true).build());
        }

        TalendMetadata metadata = TalendMetadata.builder()
                .name("row1")
                .connectorName("FLOW")
                .columns(columns)
                .build();

        return TalendNode.builder()
                .xmiId(XmiIdGenerator.generate())
                .componentName("tExtractJSONFields")
                .componentVersion("0.102")
                .posX(posX)
                .posY(posY)
                .parameters(params)
                .metadata(List.of(metadata))
                .build();
    }

    private static String sanitizeColumnName(String name) {
        if (name == null || name.isEmpty()) return "column";
        String s = name.replaceAll("[^a-zA-Z0-9_]", "_");
        if (!Character.isLetter(s.charAt(0))) s = "c_" + s;
        return s;
    }

    private static TalendElementParameter p(String field, String name, String value, boolean show) {
        return TalendElementParameter.builder()
                .field(TalendElementParameter.FieldType.valueOf(field))
                .name(name).value(value).show(show).build();
    }

    private static TableEntry row(String elementRef, String value) {
        return TableEntry.builder().elementRef(elementRef).value(value).build();
    }
}
