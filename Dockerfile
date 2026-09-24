# Stage 1: Build frontend
FROM node:20-alpine AS build-frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npx vite build

# Stage 2: Build API
FROM node:20-alpine AS build-api
WORKDIR /app
COPY api/package.json api/package-lock.json* ./
RUN npm install
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npx tsc

# Stage 3: Production
FROM node:20-alpine
WORKDIR /app
COPY api/package.json api/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build-api /app/dist ./dist
COPY --from=build-frontend /frontend/dist ./public
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
