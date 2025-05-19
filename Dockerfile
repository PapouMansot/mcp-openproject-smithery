FROM node:22.12-alpine AS builder

WORKDIR /app

COPY . .
COPY tsconfig.json ./

RUN npm install
RUN npm run build

FROM node:22-alpine AS release

WORKDIR /app

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package-lock.json ./

ENV NODE_ENV=production

RUN npm ci --ignore-scripts --omit-dev

EXPOSE 8000

ENTRYPOINT ["node", "dist/index.js"] 