FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY bot.js ./
COPY config.json ./
COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

CMD ["node", "bot.js"]
