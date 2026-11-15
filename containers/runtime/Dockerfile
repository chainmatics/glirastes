# syntax=docker/dockerfile:1
# Keep runtime and builder Node on the same immutable, multi-platform base.
FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS bun
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/glirastes
COPY package.json bun.lock ./
# Install from the committed lock. The image deliberately includes the optional
# OpenAI-compatible provider and build dependencies: the same image builds the
# customer's data-only artifacts without a customer-maintained Node project.
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.cjs.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun run build

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
LABEL org.opencontainers.image.title="Glirastes Runtime" \
      org.opencontainers.image.description="Customer-hosted Glirastes SDK runtime; one active instance per application and environment" \
      org.opencontainers.image.source="https://github.com/chainmatics/glirastes" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production
WORKDIR /opt/glirastes
COPY --from=build /opt/glirastes/package.json ./package.json
COPY --from=build /opt/glirastes/node_modules ./node_modules
COPY --from=build /opt/glirastes/dist ./dist
COPY skills ./skills
COPY LICENSE NOTICE ./
RUN chmod +x dist/runtime-service/bin.js dist/cli/bin.js \
    && ln -s /opt/glirastes/dist/runtime-service/bin.js /usr/local/bin/glirastes-runtime \
    && ln -s /opt/glirastes/dist/cli/bin.js /usr/local/bin/glirastes
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD ["glirastes-runtime", "healthcheck", "--config", "/etc/glirastes/runtime.json"]
ENTRYPOINT ["glirastes-runtime"]
CMD ["serve", "--config", "/etc/glirastes/runtime.json"]
