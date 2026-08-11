FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .


FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app ./

# node:20-alpine ships a non-root "node" user (uid 1000) for exactly this —
# no reason for an Express process that only ever handles HTTP payloads to
# run as root.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
