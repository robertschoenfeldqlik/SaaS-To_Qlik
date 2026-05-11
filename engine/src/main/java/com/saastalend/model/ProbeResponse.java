package com.saastalend.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

/**
 * Result of a single probe call. Includes both observability fields
 * (statusCode, elapsedMs, byte count) and the parsed shape — what
 * fields were actually present, how many records the recordsPath
 * matched — so the UI can compare to the spec's declared shape.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ProbeResponse {

    private int statusCode;
    private long elapsedMs;
    private long bodyBytes;

    /** Resolved fixture path on disk (null if saveFixture=false or failure). */
    private String fixturePath;

    /** ISO-8601 UTC capture timestamp. */
    private String capturedAt;

    /** Endpoint name (echoed for convenience when running batches). */
    private String endpointName;

    /** Final URL the probe hit (with base + path resolved). */
    private String url;

    /** Number of records at recordsPath. 0 = empty array, -1 = path not resolvable. */
    private int recordCount;

    /** Field shape inferred from the first record at recordsPath. */
    @Builder.Default
    private List<FieldInfo> fields = new ArrayList<>();

    /**
     * Small JSON excerpt (first record, truncated to ~2 KB) so the UI can
     * show "this is what the API returned" without round-tripping the
     * full payload.
     */
    private String responseExcerpt;

    /** Non-null on failure; statusCode may still be set (e.g. 401, 500). */
    private String error;

    /** True when PHI/PII redaction was applied before saving. */
    private boolean redacted;

    /** Number of values that were scrubbed (field-name match OR value-pattern hit). */
    private int redactedCount;

    /**
     * Dot-paths of redacted keys (capped — full list lives in the fixture
     * if needed). Useful for the UI to summarize "redacted: email, ssn, …".
     */
    @Builder.Default
    private List<String> redactedKeyPaths = new ArrayList<>();
}
