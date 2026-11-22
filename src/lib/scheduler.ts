import "server-only";
import { expireBonuses } from "./rewards";
import { isRetired } from "./platform-config";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { runDuePosts } from "./publish";
import { notifyNewReplies, notifyPostResult } from "./tg-bot";
import { refreshDueSources } from "./tg-feed";
import { checkMentions } from "./replies";
import { checkTimeline, dueTimelineUsers } from "./follow-replies";
import { runAutopilot } from "./autopilot";
import { refreshDueMemories } from "./memory";
import { runDailyReports } from "./daily-report";
import { runXNudges } from "./x-nudge";
import { runAnnouncements } from "./announce";
import { snapshotDue } from "./benchmark";
import { collectPostMetrics } from "./post-metrics";
import { runHotTopics } from "./hot-topics";
import { sendWeeklyReports } from "./tg-bot-bench";
import { postBoardToChannel } from "./bench-channel";
import { pruneImages } from "./images";
import { runDailyBackup } from "./backup";

/**
 * 后台定时任务：每 30 秒检查一次
 * - 到点的定时发布
 * - 开启了自动拉取的账号，按设定间隔拉取新提及（只生成候选，不会自动发出回复）
 * - 开启了「关注的人」的账号，按设定间隔读关注的人的新帖子，挑出值得回的写好候选推到 TG（同样只生成候选，点了才发）
 * - 信息源（TG 频道、X 主页、RSS、网页 / 论坛），按各自的间隔检查新内容，收进灵感池
 * - 自动发帖：开了的客户，每轮最多按文风写一条，全自动排进定时或推到 TG 等确认
 * - 有没付完的 USDT 充值单时扫链，到账自动入账
 * - 推主数据：每个已连接的 X 账号每天读一次公开数据（粉丝、关注、发帖数）；每周一 10 点推周报；后台打开的话，同时把涨粉榜发到 TG 频道
 * - 账号记忆：还没整理过、或本人推文新增了 10 条的客户，后台整理一次（每轮最多 3 位）
 * - 配图：30 天前的、没被草稿选中也没挂在待发帖子上的图，每小时清理一次
 * - 功能更新公告：新上线的更新记录自动起草（默认发给管理员审核）；正在群发的公告按用户当地白天分批发，避开 Telegram 限速
 * - 数据库备份：设置好以后每天一次，加密后传到 S3（失败一小时后重试）
 * - 日报：到了各人设定的钟点，给顾客发昨日小结、给管理员发经营日报（每 5 分钟看一次，只读数据库）
 *
 * 本地运行时由 instrumentation.ts 在服务启动时开启；部署到 Vercel 等无常驻进程的平台时，
 * 改用 Cron 调用 /api/cron/tick。
 */
const TICK_MS = 30_000;
let lastPrune = 0;

const g = globalThis as unknown as { __vdScheduler?: { timer: NodeJS.Timeout; running: boolean } };

export async function tick(): Promise<{ published: number; checked: number; ideas: number; auto: number }> {
  const db = await getDb();
  // 发帖出错不能挡住后面的事（尤其是扫链入账）
  const results = await runDuePosts().catch((e) => {
    console.error("[scheduler] 定时发布失败", e instanceof Error ? e.message : e);
    return [] as Awaited<ReturnType<typeof runDuePosts>>;
  });
  const published = results.length;
  // 定时帖发出 / 失败后在 TG 通知（没绑定就跳过）
  for (const post of results) await notifyPostResult(post).catch(() => {});

  // 发送中断的回复改为失败，用户可以重发
  await db
    .update(schema.replyItems)
    .set({ status: "failed", error: "发送过程被中断，请先到 X 上确认是否已经发出" })
    .where(and(eq(schema.replyItems.status, "sending"), lt(schema.replyItems.updatedAt, new Date(Date.now() - 10 * 60_000))));

  const due = await db
    .select({ userId: schema.xAccounts.userId })
    .from(schema.xAccounts)
    .where(
      and(
        eq(schema.xAccounts.autoReplyEnabled, true),
        isNull(schema.xAccounts.authError),
        or(isNull(schema.xAccounts.pausedUntil), lt(schema.xAccounts.pausedUntil, new Date())),
        or(
          isNull(schema.xAccounts.lastCheckedAt),
          sql`${schema.xAccounts.lastCheckedAt} < now() - make_interval(mins => ${schema.xAccounts.autoReplyIntervalMin})`,
        ),
      ),
    );
  let checked = 0;
  for (const { userId } of due) {
    try {
      const r = await checkMentions(userId);
      checked++;
      // 新的回复候选推到 TG，点按钮就能发
      if (r.added) await notifyNewReplies(userId).catch((e) => console.error("[scheduler] 推送回复候选失败", e));
    } catch (e) {
      console.error("[scheduler] 拉取提及失败", e instanceof Error ? e.message : e);
      // 出错也记下时间，避免每 30 秒重试一次
      await db.update(schema.xAccounts).set({ lastCheckedAt: new Date() }).where(eq(schema.xAccounts.userId, userId));
    }
  }
  for (const userId of await dueTimelineUsers()) {
    try {
      const r = await checkTimeline(userId);
      checked++;
      if (r.added) await notifyNewReplies(userId).catch((e) => console.error("[scheduler] 推送回复候选失败", e));
    } catch (e) {
      console.error("[scheduler] 读取关注的人失败", e instanceof Error ? e.message : e);
      await db.update(schema.xAccounts).set({ timelineCheckedAt: new Date() }).where(eq(schema.xAccounts.userId, userId));
    }
  }
  let ideas = 0;
  try {
    ideas = await refreshDueSources();
  } catch (e) {
    console.error("[scheduler] 检查频道失败", e instanceof Error ? e.message : e);
  }
  let auto = 0;
  try {
    auto = await runAutopilot();
  } catch (e) {
    console.error("[scheduler] 自动发帖失败", e instanceof Error ? e.message : e);
  }
  try {
    await expireBonuses();
  } catch (e) {
    console.error("[scheduler] 赠送额度到期处理失败", e instanceof Error ? e.message : e);
  }
  try {
    await refreshDueMemories();
  } catch (e) {
    console.error("[scheduler] 整理账号记忆失败", e instanceof Error ? e.message : e);
  }
  try {
    await collectPostMetrics();
  } catch (e) {
    console.error("[scheduler] 读取发帖效果失败", e instanceof Error ? e.message : e);
  }
  try {
    await runHotTopics();
  } catch (e) {
    console.error("[scheduler] 热点提醒失败", e instanceof Error ? e.message : e);
  }
  try {
    await snapshotDue();
    await sendWeeklyReports();
    await postBoardToChannel();
  } catch (e) {
    console.error("[scheduler] 推主数据失败", e instanceof Error ? e.message : e);
  }
  // 配图清理：每小时最多一次
  if (Date.now() - lastPrune > 3600_000) {
    lastPrune = Date.now();
    await pruneImages().catch((e) => console.error("[scheduler] 清理配图失败", e instanceof Error ? e.message : e));
  }
  try {
    await runDailyReports();
  } catch (e) {
    console.error("[scheduler] 发日报失败", e instanceof Error ? e.message : e);
  }
  try {
    await runXNudges();
  } catch (e) {
    console.error("[scheduler] 提醒连接 X 失败", e instanceof Error ? e.message : e);
  }
  try {
    await runAnnouncements();
  } catch (e) {
    console.error("[scheduler] 发公告失败", e instanceof Error ? e.message : e);
  }
  // 备份放最后：慢一点也不耽误发帖和扫链
  await runDailyBackup().catch((e) => console.error("[scheduler] 数据库备份失败", e instanceof Error ? e.message : e));
  return { published, checked, ideas, auto };
}

export function startScheduler() {
  if (g.__vdScheduler) return;
  const state = {
    running: false,
    timer: setInterval(async () => {
      // 已搬到服务器、这一份退役了：不再发帖、不再拉取
      if (state.running || isRetired()) return;
      state.running = true;
      try {
        await tick();
      } catch (e) {
        console.error("[scheduler]", e);
      } finally {
        state.running = false;
      }
    }, TICK_MS),
  };
  state.timer.unref?.();
  g.__vdScheduler = state;
}
