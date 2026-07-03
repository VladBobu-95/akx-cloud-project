# --- Etapa 1: build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Etapa 2: runtime ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Datos de idioma de Tesseract vendorizados: se cargan en local (langPath) para no
# depender de una descarga desde un CDN en tiempo de ejecución (que se colgaba en
# el servidor sin salida a internet). Debe quedar en /app/tessdata (WORKDIR).
COPY tessdata ./tessdata
EXPOSE 3000
CMD ["node", "dist/index.js"]
