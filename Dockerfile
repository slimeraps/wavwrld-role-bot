FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund


FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY bot.js ./
COPY config.json ./
COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

CMD ["node", "bot.js"]
