# 安全问题反馈

发现安全漏洞请不要公开提 Issue，用 GitHub 仓库页的 **Security → Report a vulnerability** 私下告诉我们。

自己部署时请注意：

- 线上必须设置 `TOKEN_ENCRYPTION_KEY`、`CRON_SECRET`、`TELEGRAM_WEBHOOK_SECRET`（至少 16 位随机字符）和 `ADMIN_EMAILS`。
- 不要把 `.env*`、`.data/` 提交到仓库；密钥泄露后请立刻去对应平台轮换。
- 限流按 x-forwarded-for 从右往左数的 IP 计算，默认前面有 1 层可信代理；多一层（例如 Cloudflare）就设 `TRUSTED_PROXY_HOPS=2`。直接暴露在公网、没有代理时请先在前面加一层代理。
