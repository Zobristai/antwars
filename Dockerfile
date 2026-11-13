# One container, one port: the game server with the spectator page.

# Build stage: .npmrc carries include=dev, so npm ci installs the dev packages and its
# prepare script runs the web build (npm run build:web) into web/dist.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY web ./web
COPY src ./src
RUN npm ci --no-audit --no-fund

# Runtime sources: src without the modules that no command run in this image (npm start, npm run
# record-service) imports; test/image/runtime-files.test.ts checks this list against their import
# closure. Pruned in a stage of its own, so no layer of the runtime image holds the removed files.
FROM build AS runtime-src
RUN rm -r src/live/record.ts src/live/replayOptions.ts src/sim/tuningMap.ts src/sim/quadrantMap.ts

# Runtime stage: production packages only. No .npmrc, so --omit=dev holds, and the dev-only
# H.264 encoder (@ffmpeg-installer) is never installed; scripts are skipped because the
# page is already built.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=runtime-src /app/src ./src
COPY web/rules.ts ./web/rules.ts
COPY --from=build /app/web/dist ./web/dist

# Operator configuration: PORT and DATA_DIR only. Match logs are written under DATA_DIR.
ENV PORT=8080 DATA_DIR=/data
# This build honours slot marks and the records overlap signal; deploy.sh all reads this label
# to choose a rolling deploy when the deploy checkout lacks the history that shows it.
LABEL ai.antwars.rolling-support=1
EXPOSE 8080
CMD ["npm", "start"]
