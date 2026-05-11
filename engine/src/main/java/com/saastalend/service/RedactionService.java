package com.saastalend.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Walks a JSON tree and redacts PHI / PII values before persistence.
 *
 * Two detection tracks:
 *   1. Field-name match — the KEY matches a sensitive-name pattern
 *      (e.g. "ssn", "email", "patient_id", "dob"). The whole value is
 *      replaced regardless of what's in it.
 *   2. Value-pattern match — the VALUE matches a sensitive-value regex
 *      (e.g. email-shape, SSN-shape, credit-card-shape). This catches
 *      PHI hidden under innocuous field names like "note" or "comment".
 *
 * Type preservation: redacted values keep their original JSON type so
 * downstream schema-diffing remains accurate.
 *   - string  -> "[REDACTED]"
 *   - number  -> 0
 *   - boolean -> false
 *   - array   -> []   (we don't recurse into arrays for value-match;
 *                       schema-detection only cares about the type)
 *   - object  -> recurse into the object, applying field-name + value
 *                checks on every key
 *
 * Result is a NEW node tree — input is not mutated. Includes a sidecar
 * RedactionReport listing the dot-path of every key we touched so the
 * UI can show "X fields redacted" without re-running the scan.
 */
@Service
public class RedactionService {

    /** Default field-name patterns (regex, case-insensitive, anchored). */
    public static final List<String> DEFAULT_NAME_PATTERNS = List.of(
            // Personal identifiers
            "^(?:first[_-]?name|last[_-]?name|full[_-]?name|middle[_-]?name|maiden[_-]?name|user[_-]?name|display[_-]?name|nick[_-]?name|surname|family[_-]?name|given[_-]?name|preferred[_-]?name)$",
            "^name$",
            // Contact
            "^(?:email|e[_-]?mail|email[_-]?address|primary[_-]?email|work[_-]?email|personal[_-]?email)$",
            "^(?:phone|mobile|telephone|fax|cell|home[_-]?phone|work[_-]?phone)(?:[_-]?number)?$",
            // Postal / location
            "^(?:address|street|street[_-]?address|address[_-]?line[_-]?\\d?|city|state|province|region|zip|zip[_-]?code|postal|postal[_-]?code|country)$",
            "^(?:lat|latitude|lng|long|longitude|geo[_-]?(?:lat|long|location|point))$",
            // Government / national IDs
            "^(?:ssn|social[_-]?security(?:[_-]?number)?|sin|tax[_-]?id|tin|ein|passport(?:[_-]?number)?|driver[_-]?licen[cs]e(?:[_-]?number)?|nationa[_-]?id)$",
            // Medical (PHI)
            "^(?:mrn|medical[_-]?record(?:[_-]?number)?|patient[_-]?id|patient[_-]?number|chart(?:[_-]?number)?|npi|diagnosis|icd(?:[_-]?code)?|cpt(?:[_-]?code)?|prescription|medication|rx[_-]?(?:number|num)?)$",
            // Financial
            "^(?:card[_-]?number|cc[_-]?number|credit[_-]?card|card[_-]?cvv|cvv|cvc|bank[_-]?account|account[_-]?number|iban|routing(?:[_-]?number)?|swift)$",
            // Auth secrets / tokens (defensive — these should never be in API responses but if they are, redact)
            "^(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|session[_-]?id|auth[_-]?token)$",
            // Birth date
            "^(?:dob|date[_-]?of[_-]?birth|birth[_-]?date|birthday)$",
            // Network identifiers
            "^(?:ip|ip[_-]?address|client[_-]?ip|remote[_-]?addr)$"
    );

    /** Default value-pattern matchers (regex on string values regardless of key). */
    public static final List<String> DEFAULT_VALUE_PATTERNS = List.of(
            // Email
            "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
            // US SSN (NNN-NN-NNNN)
            "\\b\\d{3}-\\d{2}-\\d{4}\\b",
            // US phone (multiple shapes)
            "\\b(?:\\+?1[-.\\s]?)?\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}\\b",
            // Credit-card-like 13-19 digit run with optional separators (covers Visa/MC/Amex)
            "\\b(?:\\d[ -]?){13,19}\\b",
            // IPv4
            "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b"
    );

    private static final String STRING_PLACEHOLDER = "[REDACTED]";

    private final ObjectMapper mapper = new ObjectMapper();

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class RedactionConfig {
        @Builder.Default
        private boolean enabled = true;

        /** When null, falls back to DEFAULT_NAME_PATTERNS. */
        private List<String> nameRegexes;

        /** When null, falls back to DEFAULT_VALUE_PATTERNS. */
        private List<String> valueRegexes;

        /** Override the default placeholder for redacted string values. */
        @Builder.Default
        private String stringPlaceholder = STRING_PLACEHOLDER;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class RedactionReport {
        private JsonNode redacted;
        /** Dot-paths of every key whose value was redacted (e.g. "user.email"). */
        @Builder.Default
        private List<String> redactedKeyPaths = new ArrayList<>();
        private int redactedCount;
    }

    public RedactionReport redact(JsonNode root, RedactionConfig cfg) {
        RedactionConfig config = cfg == null ? RedactionConfig.builder().build() : cfg;
        List<Pattern> namePatterns  = compile(config.getNameRegexes()  != null ? config.getNameRegexes()  : DEFAULT_NAME_PATTERNS,  Pattern.CASE_INSENSITIVE);
        List<Pattern> valuePatterns = compile(config.getValueRegexes() != null ? config.getValueRegexes() : DEFAULT_VALUE_PATTERNS, 0);

        RedactionReport report = RedactionReport.builder().build();
        if (root == null || !config.isEnabled()) {
            report.setRedacted(root);
            return report;
        }
        JsonNode out = walk(root, "", namePatterns, valuePatterns, config.getStringPlaceholder(), report);
        report.setRedacted(out);
        return report;
    }

    /** Convenience: redact a raw JSON body string, return a redacted JSON string + report. */
    public RedactionReport redactString(String jsonBody, RedactionConfig cfg) {
        try {
            JsonNode root = mapper.readTree(jsonBody);
            RedactionReport rep = redact(root, cfg);
            return rep;
        } catch (Exception e) {
            // Not parseable as JSON — return as-is to avoid losing the capture
            RedactionReport rep = RedactionReport.builder().build();
            // Best-effort: pass through. Caller can serialize null-safely.
            return rep;
        }
    }

    private JsonNode walk(JsonNode node, String path,
                          List<Pattern> namePatterns, List<Pattern> valuePatterns,
                          String stringPlaceholder,
                          RedactionReport report) {
        if (node == null || node.isNull()) return node;

        if (node.isObject()) {
            ObjectNode obj = (ObjectNode) node;
            ObjectNode copy = mapper.createObjectNode();
            Iterator<Map.Entry<String, JsonNode>> it = obj.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                String key = e.getKey();
                JsonNode value = e.getValue();
                String childPath = path.isEmpty() ? key : path + "." + key;

                if (matchesAny(key, namePatterns)) {
                    copy.set(key, redactValuePreservingType(value, stringPlaceholder));
                    report.getRedactedKeyPaths().add(childPath);
                    report.setRedactedCount(report.getRedactedCount() + 1);
                } else {
                    copy.set(key, walk(value, childPath, namePatterns, valuePatterns, stringPlaceholder, report));
                }
            }
            return copy;
        }

        if (node.isArray()) {
            ArrayNode arr = (ArrayNode) node;
            ArrayNode copy = mapper.createArrayNode();
            for (int i = 0; i < arr.size(); i++) {
                copy.add(walk(arr.get(i), path + "[" + i + "]", namePatterns, valuePatterns, stringPlaceholder, report));
            }
            return copy;
        }

        // Scalars — only string scalars can match value patterns
        if (node.isTextual()) {
            String original = node.asText();
            String redacted = applyValueRedaction(original, valuePatterns, stringPlaceholder);
            if (!redacted.equals(original)) {
                report.getRedactedKeyPaths().add(path + " (value-match)");
                report.setRedactedCount(report.getRedactedCount() + 1);
                return mapper.getNodeFactory().textNode(redacted);
            }
        }
        return node;
    }

    /** Replace value matching any sensitive pattern within a string, substring-by-substring. */
    private String applyValueRedaction(String s, List<Pattern> valuePatterns, String stringPlaceholder) {
        String out = s;
        for (Pattern p : valuePatterns) {
            out = p.matcher(out).replaceAll(stringPlaceholder);
        }
        return out;
    }

    /** Replace the whole value while keeping its JSON type. */
    private JsonNode redactValuePreservingType(JsonNode value, String stringPlaceholder) {
        if (value == null || value.isNull()) return value;
        if (value.isTextual())  return mapper.getNodeFactory().textNode(stringPlaceholder);
        if (value.isInt())      return mapper.getNodeFactory().numberNode(0);
        if (value.isLong())     return mapper.getNodeFactory().numberNode(0L);
        if (value.isFloat())    return mapper.getNodeFactory().numberNode(0.0f);
        if (value.isDouble() || value.isBigDecimal())
                                return mapper.getNodeFactory().numberNode(0.0);
        if (value.isBoolean())  return mapper.getNodeFactory().booleanNode(false);
        if (value.isArray())    return mapper.createArrayNode();
        if (value.isObject())   return mapper.createObjectNode();
        return mapper.getNodeFactory().textNode(stringPlaceholder);
    }

    /**
     * Field-name regexes are already anchored with ^...$ — matches() is the
     * right check. We deliberately do NOT fall back to find(), which would
     * cause "filename" to match the bare "^name$" pattern.
     */
    private static boolean matchesAny(String s, List<Pattern> patterns) {
        for (Pattern p : patterns) {
            if (p.matcher(s).matches()) return true;
        }
        return false;
    }

    private static List<Pattern> compile(List<String> regexes, int flags) {
        List<Pattern> out = new ArrayList<>(regexes.size());
        for (String r : regexes) {
            try { out.add(Pattern.compile(r, flags)); }
            catch (Exception ignored) { /* skip bad regex */ }
        }
        return out;
    }
}
