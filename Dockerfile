FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN mkdir -p apps/web apps/worker packages/blockchain packages/config packages/db packages/domain packages/ingestion packages/market-data packages/observability packages/queue packages/validation
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/blockchain/package.json ./packages/blockchain/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/ingestion/package.json ./packages/ingestion/package.json
COPY packages/market-data/package.json ./packages/market-data/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/queue/package.json ./packages/queue/package.json
COPY packages/validation/package.json ./packages/validation/package.json

RUN npm install --global npm@11.6.0 \
  && test "$(npm --version)" = "11.6.0" \
  && npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN npm install --global npm@11.6.0 \
  && test "$(npm --version)" = "11.6.0"

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/src ./apps/worker/src
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/blockchain/package.json ./packages/blockchain/package.json
COPY --from=build /app/packages/blockchain/src ./packages/blockchain/src
COPY --from=build /app/packages/blockchain/dist ./packages/blockchain/dist
COPY --from=build /app/packages/config/package.json ./packages/config/package.json
COPY --from=build /app/packages/config/src ./packages/config/src
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/src ./packages/db/src
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /app/packages/domain/src ./packages/domain/src
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/ingestion/package.json ./packages/ingestion/package.json
COPY --from=build /app/packages/ingestion/src ./packages/ingestion/src
COPY --from=build /app/packages/ingestion/dist ./packages/ingestion/dist
COPY --from=build /app/packages/market-data/package.json ./packages/market-data/package.json
COPY --from=build /app/packages/market-data/src ./packages/market-data/src
COPY --from=build /app/packages/market-data/dist ./packages/market-data/dist
COPY --from=build /app/packages/observability/package.json ./packages/observability/package.json
COPY --from=build /app/packages/observability/src ./packages/observability/src
COPY --from=build /app/packages/observability/dist ./packages/observability/dist
COPY --from=build /app/packages/queue/package.json ./packages/queue/package.json
COPY --from=build /app/packages/queue/src ./packages/queue/src
COPY --from=build /app/packages/queue/dist ./packages/queue/dist
COPY --from=build /app/packages/validation/package.json ./packages/validation/package.json
COPY --from=build /app/packages/validation/src ./packages/validation/src
COPY --from=build /app/packages/validation/dist ./packages/validation/dist

CMD ["npm", "run", "start", "--workspace", "@swi/worker"]