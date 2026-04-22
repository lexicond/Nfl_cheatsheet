# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app

# Build tools needed in case better-sqlite3 has no prebuilt for this arch
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install server dependencies
COPY package*.json ./
RUN npm ci

# Install and build the React client
COPY client/package*.json ./client/
RUN cd client && npm install
COPY . .
RUN cd client && npm run build

# ---- Runtime stage ----
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json .

EXPOSE 3000
CMD ["node", "server/index.js"]
