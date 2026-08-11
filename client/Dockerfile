FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Same-origin /api convenience mode (see vite.config.js) — nginx.conf proxies
# /api/ to the backend service, so the built bundle doesn't need CORS.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build


# nginxinc/nginx-unprivileged, not nginx:1.27-alpine — the stock image's
# master process needs root to bind port 80; this image runs entirely as
# non-root uid 101 and listens on 8080 instead (see nginx.conf's `listen`
# directive and the Traefik dynamic.yml service pointing at client:8080).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
