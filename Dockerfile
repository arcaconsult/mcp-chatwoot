FROM oven/bun:1.3-slim

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "start:http"]
