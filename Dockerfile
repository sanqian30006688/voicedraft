# VoiceDraft 服务器部署（Railway / Render / Fly.io / 任意能跑 Docker 的服务器都可以用）
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# 平台会通过 PORT 告诉我们用哪个端口
CMD ["sh", "-c", "npx next start -H 0.0.0.0 -p ${PORT:-3000}"]
