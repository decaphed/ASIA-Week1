FROM node:20.20.2-alpine3.23 AS build
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
FROM nginxinc/nginx-unprivileged:1.27.5-alpine3.21
COPY --from=build /app/dist /usr/share/nginx/html
# Template, not a plain conf — the image's own docker-entrypoint.d script
# (20-envsubst-on-templates.sh, present on nginx(-unprivileged) images since
# 1.19) runs envsubst on every /etc/nginx/templates/*.template at container
# start and writes the result to /etc/nginx/conf.d/, substituting only
# variables that are actually set in the container environment — so nginx's
# own lowercase built-ins ($host, $remote_addr, etc.) are left untouched and
# only ${INTERNAL_PROXY_SECRET} gets filled in. See docker-compose.yml's
# client service for where that env var comes from.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
