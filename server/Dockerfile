FROM node:20.20.2-alpine3.23 AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .


FROM node:20.20.2-alpine3.23
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app ./

# node:20-alpine ships a non-root "node" user (uid 1000) for exactly this —
# no reason for an Express process that only ever handles HTTP payloads to
# run as root.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "server.js"]
