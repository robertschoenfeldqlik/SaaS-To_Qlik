package com.saastalend.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TalendElementParameter {

    public enum FieldType {
        TEXT,
        CHECK,
        CLOSED_LIST,
        TABLE,
        MEMO,
        ENCODING_TYPE,
        SCHEMA_TYPE,
        LABEL,
        HIDDEN_TEXT,
        COMPONENT_LIST,
        RADIO,
        // TaCoKit-era field types used by HTTPClient and other modern components
        TECHNICAL,
        PASSWORD,
        TACOKIT_VALUE_SELECTION,
        DIRECTORY,
        PREV_COLUMN_LIST
    }

    /**
     * One row inside a TABLE elementParameter, e.g. a single header or query
     * parameter. Real Talend XML emits these as nested
     * &lt;elementValue elementRef="..." value="..."/&gt; children.
     */
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class TableEntry {
        private String elementRef;
        private String value;
    }

    private FieldType field;
    private String name;
    private String value;

    /** Nested rows for TABLE-typed parameters. Null/empty = no children emitted. */
    @Builder.Default
    private List<TableEntry> tableEntries = new ArrayList<>();

    @Builder.Default
    private boolean show = true;
}
