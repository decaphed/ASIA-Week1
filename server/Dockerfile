FROM node:20-alpine AS build
WORKDIR /app

# better-sqlite3 compiles a native addon at install time.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .


FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app ./

EXPOSE 3000
CMD ["node", "server.js"]
