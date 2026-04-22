# Production frontend image: build the Vite SPA, serve it with nginx.
# The nginx config proxies /api/* to the backend service so the SPA uses
# the same origin for both static assets and API calls.

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
