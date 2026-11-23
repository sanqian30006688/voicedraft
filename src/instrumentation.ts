export async function register() {
  // 本地 / 常驻进程部署时，在服务启动时开启定时发布与提及拉取。
  // Vercel 等无常驻进程的平台没有意义，改用 Cron 调用 /api/cron/tick。
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL && process.env.DISABLE_SCHEDULER !== "1") {
    // 服务器上：后台保存的平台密钥（X 应用、TG 机器人）存在数据库里，先读回来
    if (process.env.DATABASE_URL) {
      const { loadPlatformEnv } = await import("./lib/platform-config");
      await loadPlatformEnv().catch((e) => console.error("[platform] 读取平台密钥失败", e));
    }
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
    // TG 机器人：用长轮询接收消息，不需要额外设置 webhook
    const { startTelegramPolling } = await import("./lib/telegram");
    startTelegramPolling();
  }
}
