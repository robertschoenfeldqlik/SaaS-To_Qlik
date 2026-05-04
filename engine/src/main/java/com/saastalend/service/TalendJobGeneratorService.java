package com.saastalend.service;

import com.saastalend.generator.*;
import com.saastalend.model.*;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Service
public class TalendJobGeneratorService {

    /**
     * Generates a TalendJob with the standard REST-to-output pipeline for a discovered endpoint.
     * All credentials and URLs use Talend context variables (context.VAR_NAME).
     */
    public TalendJob generateJob(DiscoveredEndpoint endpoint, AuthConfig auth,
                                  String baseUrl, String outputType) {
        String jobName = sanitizeJobName(endpoint.getName());
        String jobId = UUID.randomUUID().toString();

        List<TalendNode> nodes = new ArrayList<>();
        List<TalendConnection> connections = new ArrayList<>();

        // Pipeline matches real Talend Studio 8.0.1 output:
        //   HTTPClient (was tRESTClient) → tExtractJSONFields → tLogRow + tFileOutputJSON
        // HTTPClient emits a FLOW connector named "row1" carrying a "body" id_String column.

        // Node 1: HTTPClient — calls the API (uses context.API_BASE_URL + path)
        TalendNode httpClient = TRESTClientGenerator.generate(endpoint, auth, baseUrl, 100, 100);
        nodes.add(httpClient);

        // Node 2: tExtractJSONFields — extracts records from JSON response
        TalendNode extractJson = TExtractJSONFieldsGenerator.generate(endpoint, 350, 100);
        nodes.add(extractJson);

        // Node 3: tLogRow — console debugging output
        TalendNode logRow = TLogRowGenerator.generate(600, 50);
        nodes.add(logRow);

        // Node 4: tFileOutputJSON — writes to context.OUTPUT_DIR + filename
        TalendNode fileOutput = TFileOutputJSONGenerator.generate(
                "context.OUTPUT_DIR + \"/" + jobName + ".json\"", 600, 150);
        nodes.add(fileOutput);

        // Wire connections
        String httpClientName  = getUniqueName(httpClient);
        String extractJsonName = getUniqueName(extractJson);
        String logRowName      = getUniqueName(logRow);
        String fileOutputName  = getUniqueName(fileOutput);

        // HTTPClient → tExtractJSONFields (FLOW row1, since HTTPClient outputs FLOW)
        connections.add(ConnectionGenerator.generate(
                httpClientName, extractJsonName, "FLOW", "row1"));

        // tExtractJSONFields → tLogRow (FLOW row2)
        connections.add(ConnectionGenerator.generate(
                extractJsonName, logRowName, "FLOW", "row2"));

        // tExtractJSONFields → tFileOutputJSON (FLOW row3)
        connections.add(ConnectionGenerator.generate(
                extractJsonName, fileOutputName, "FLOW", "row3"));

        return TalendJob.builder()
                .id(jobId)
                .name(jobName)
                .description("Extract " + endpoint.getName() + " from API via REST")
                .nodes(nodes)
                .connections(connections)
                .endpoint(endpoint)
                .authConfig(auth)
                .outputType(outputType != null ? outputType : "JSON")
                .status("GENERATED")
                .build();
    }

    private String sanitizeJobName(String name) {
        if (name == null || name.isEmpty()) {
            return "unnamed_job";
        }
        String sanitized = name.replaceAll("[^a-zA-Z0-9_]", "_");
        if (!Character.isLetter(sanitized.charAt(0))) {
            sanitized = "job_" + sanitized;
        }
        return sanitized;
    }

    private String getUniqueName(TalendNode node) {
        return node.getParameters().stream()
                .filter(p -> "UNIQUE_NAME".equals(p.getName()))
                .map(TalendElementParameter::getValue)
                .findFirst()
                .orElse(node.getComponentName() + "_1");
    }
}
