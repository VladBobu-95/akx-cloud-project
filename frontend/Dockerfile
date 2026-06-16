# --- Etapa 1: build de Angular ---
# Angular CLI (v22) requiere Node >= 22.22 / 24 / 26.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Etapa 2: servir con nginx ---
FROM nginx:alpine
# Config propia: SPA + proxy /api -> backend
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Archivos estáticos del build de Angular (carpeta browser del builder application)
COPY --from=build /app/dist/akx-cloud-frontend/browser /usr/share/nginx/html
EXPOSE 80
