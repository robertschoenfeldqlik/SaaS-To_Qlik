# ═══════════════════════════════════════════════════════════════════════════
# SaaS to Talend — single-image multi-stage Dockerfile
#
# Runs all three services inside one container:
#   • Java Spring Boot engine (port 8081)          — Talend XML generator
#   • Node.js Express server  (port 3000)          — API proxy + SQLite store
#   • React SPA (served by Express from /client/dist)
#
# Exposed port: 3000. That's the only port a user needs to hit.
# Node Express serves the React build on / and proxies /api/engine/* to the
# Java JVM running side-by-side inside the same container.
#
# Build:  docker build -t saas-to-talend .
# Run:    docker run -p 3000:3000 saas-to-talend
#         then open http://localhost:3000
# ═══════════════════════════════════════════════════════════════════════════

# ─── STAGE 1: build the Java engine ────────────────────────────────────────
FROM maven:3.9.9-eclipse-temurin-17 AS engine-build
WORKDIR /build
COPY engine/pom.xml .
# Pre-fetch deps to leverage layer cache when only source changes
RUN mvn -B -q dependency:go-offline
COPY engine/src ./src
RUN mvn -B -q package -DskipTests \
 && cp target/saas-talend-engine-*.jar /build/engine.jar

# ─── STAGE 2: build the React client ───────────────────────────────────────
FROM node:22-alpine AS client-build
WORKDIR /build
COPY app/client/package*.json ./
RUN npm ci --no-audit --no-fund
COPY app/client .
RUN npm run build

# ─── STAGE 3: server deps only (cacheable) ─────────────────────────────────
FROM node:22-alpine AS server-deps
WORKDIR /build
COPY app/server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ─── FINAL STAGE: runtime image ────────────────────────────────────────────
# Use the official node:22-alpine base (pins Node to the 22.x LTS line) and
# add OpenJDK 17 JRE on top. Earlier versions of this Dockerfile based on
# eclipse-temurin:17-jre-alpine + `apk add nodejs` silently drifted to
# whatever node version Alpine shipped (we observed v24 in production
# while the build stages were pinned to 20). Inverting the base — Node
# primary, JRE addon — gives us a single explicit pin for both runtimes.
FROM node:22-alpine

# Add the JRE for the Java engine and tini for proper PID 1 init. We also
# remove the globally-installed npm: at runtime we only run `node` and
# `java`, never `npm`, so leaving the bundled npm around just keeps its
# transitive deps (e.g. picomatch) showing up in CVE scans for no reason.
# Server + client modules are already installed in their respective build
# stages and copied over below.
RUN apk add --no-cache openjdk17-jre bash curl tini \
 && npm uninstall -g npm 2>/dev/null || true \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /opt/app

# Java engine
COPY --from=engine-build /build/engine.jar ./engine.jar

# Express server (code + pre-installed deps)
COPY --from=server-deps /build/node_modules ./server/node_modules
COPY app/server/src    ./server/src
COPY app/server/package.json ./server/

# React build (served by Express as static files)
COPY --from=client-build /build/dist ./client/dist

# Persistent data directory (SQLite + AI settings + probe fixtures)
RUN mkdir -p /opt/app/server/data
VOLUME ["/opt/app/server/data"]

# Boot script: starts Java engine + Express in background, keeps PID 1 alive
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Hand ownership to the unprivileged 'node' user (uid 1000, pre-created by
# node:alpine) and switch to it. The runtime never needs root after this —
# both the Java engine and Express only listen on ports >1024 and write
# only under /opt/app/server/data. Captured probe fixtures will be created
# by uid 1000, so the named volume inherits those permissions on first
# `docker run`. If you mount a host directory for the volume, that host
# path must be writable by uid 1000 (or pass --user $(id -u):$(id -g)).
RUN chown -R node:node /opt/app

USER node

ENV NODE_ENV=production \
    ENGINE_URL=http://localhost:8081 \
    PORT=3000

EXPOSE 3000 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/api/health && \
      curl -f http://localhost:8081/api/engine/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
