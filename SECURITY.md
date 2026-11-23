# 安全问题反馈

发现安全漏洞请不要公开提 Issue，用 GitHub 仓库页的 **Security → Report a vulnerability** 私下告诉我们。

自己部署时请注意：

- 线上必须设置 `TOKEN_ENCRYPTION_KEY`、`CRON_SECRET`、`TELEGRAM_WEBHOOK_SECRET`（至少 16 位随机字符）和 `ADMIN_EMAILS`。
- 不要把 `.env*`、`.data/` 提交到仓库；密钥泄露后请立刻去对应平台轮换。
- 限流按请求头里的来访 IP 计算，请只在可信的反向代理后面部署。
