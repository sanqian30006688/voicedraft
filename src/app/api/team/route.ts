import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { fmtUsdt, getConfig, InsufficientBalanceError, ledgerLabel } from "@/lib/billing";
import { PublishError } from "@/lib/publish";
import {
  approve,
  canReview,
  createInvite,
  createTeam,
  dissolveTeam,
  displayName,
  editSubmission,
  joinTeam,
  leaveTeam,
  listSubmissions,
  myTeam,
  namesFor,
  overview,
  previewInvite,
  reject,
  removeMember,
  renameTeam,
  revokeInvites,
  setOfficial,
  clearOfficial,
  submissionPost,
  submissionView,
  submit,
  teamLedger,
  TeamError,
  TeamPublishError,
  updateMember,
  updateTeamSettings,
  withdraw,
  type SubmissionRow,
} from "@/lib/team";
import { chatOf, notifyReviewers } from "@/lib/tg-bot-team";
import { sendMessage } from "@/lib/tg-api";

async function views(rows: SubmissionRow[]) {
  const names = await namesFor(rows.flatMap((r) => [r.authorUserId, r.reviewerUserId]));
  return Promise.all(rows.map(async (r) => submissionView(r, await submissionPost(r), names)));
}

/** 团队页：团队总览、投稿、团队钱包流水；?join=邀请码 时顺便返回是哪个团队 */
export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const join = new URL(request.url).searchParams.get("join");
  const invite = join ? await previewInvite(join) : null;
  const team = await overview(user.id);
  if (!team) return Response.json({ team: null, invite, joinCode: join, minBalance: (await getConfig()).teamMinBalance });
  const reviewer = canReview(team.role);
  const [pending, mine, recent, ledger] = await Promise.all([
    reviewer ? listSubmissions(user.id, "pending") : Promise.resolve([]),
    listSubmissions(user.id, "mine", 20),
    reviewer ? listSubmissions(user.id, "recent", 20) : Promise.resolve([]),
    teamLedger(user.id, 50),
  ]);
  return Response.json({
    team,
    invite,
    joinCode: join,
    pending: await views(pending),
    mine: await views(mine),
    recent: await views(recent.filter((r) => r.status !== "pending")),
    ledger: ledger.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      who: r.actorName ?? "",
      text: ledgerLabel({ ...r, actorName: null }),
      amount: fmtUsdt(r.amountMicro),
    })),
  });
}

const Limit = z.string().max(20).nullable().optional();
const Tweets = z.array(z.string().max(5000)).min(1).max(25);

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string().max(100) }),
  z.object({ action: z.literal("rename"), name: z.string().max(100) }),
  z.object({ action: z.literal("join"), code: z.string().min(4).max(60) }),
  z.object({ action: z.literal("leave") }),
  z.object({ action: z.literal("dissolve") }),
  z.object({ action: z.literal("invite") }),
  z.object({ action: z.literal("revokeInvites") }),
  z.object({ action: z.literal("settings"), fallbackPersonal: z.boolean().optional(), defaultDaily: Limit, defaultMonthly: Limit }),
  z.object({ action: z.literal("member"), userId: z.string().uuid(), role: z.enum(["admin", "member"]).optional(), daily: Limit, monthly: Limit }),
  z.object({ action: z.literal("remove"), userId: z.string().uuid() }),
  z.object({ action: z.literal("official"), on: z.boolean() }),
  z.object({ action: z.literal("clearOfficial") }),
  z.object({ action: z.literal("submit"), tweets: Tweets, note: z.string().max(300).optional() }),
  z.object({ action: z.literal("edit"), id: z.string().uuid(), tweets: Tweets }),
  z.object({ action: z.literal("approve"), id: z.string().uuid(), scheduledAt: z.string().datetime({ offset: true }).nullable().optional() }),
  z.object({ action: z.literal("reject"), id: z.string().uuid(), reason: z.string().max(300).optional() }),
  z.object({ action: z.literal("withdraw"), id: z.string().uuid() }),
]);

async function tell(userId: string, text: string) {
  const chat = await chatOf(userId);
  if (chat) await sendMessage(chat, text).catch(() => {});
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请求格式不对" }, { status: 400 });
  const b = parsed.data;
  try {
    switch (b.action) {
      case "create":
        await createTeam(user.id, b.name);
        break;
      case "rename":
        await renameTeam(user.id, b.name);
        break;
      case "join": {
        const t = await joinTeam(user.id, b.code);
        await tell(t.ownerUserId, `${await displayName(user.id)} 加入了团队「${t.name}」。可以在网页「团队」页给他设额度。`);
        break;
      }
      case "leave": {
        const t = await myTeam(user.id);
        await leaveTeam(user.id);
        if (t) await tell(t.team.ownerUserId, `${await displayName(user.id)} 退出了团队「${t.team.name}」。`);
        break;
      }
      case "dissolve":
        await dissolveTeam(user.id);
        break;
      case "invite": {
        const inv = await createInvite(user.id);
        const { botUsername } = await import("@/lib/telegram");
        const bot = await botUsername().catch(() => null);
        return Response.json({
          code: inv.code,
          expiresAt: inv.expiresAt.toISOString(),
          tgUrl: bot ? `https://t.me/${bot}?start=team_${inv.code}` : null,
        });
      }
      case "revokeInvites":
        await revokeInvites(user.id);
        break;
      case "settings":
        await updateTeamSettings(user.id, b);
        break;
      case "member":
        await updateMember(user.id, b.userId, b);
        break;
      case "remove":
        await removeMember(user.id, b.userId);
        await tell(b.userId, "你已被移出团队，之后用的功能只扣你自己的余额。");
        break;
      case "official":
        await setOfficial(user.id, b.on);
        break;
      case "clearOfficial":
        await clearOfficial(user.id);
        break;
      case "submit": {
        const sub = await submit(user.id, b.tweets, b.note);
        await notifyReviewers(sub).catch(() => {});
        return Response.json({ item: (await views([sub]))[0] });
      }
      case "edit":
        await editSubmission(user.id, b.id, b.tweets);
        break;
      case "approve": {
        const when = b.scheduledAt ? new Date(b.scheduledAt) : null;
        const { sub, post, handle } = await approve(user.id, b.id, when);
        const url = post.postIds[0] ? `https://x.com/${handle}/status/${post.postIds[0]}` : null;
        if (sub.authorUserId !== user.id) {
          await tell(
            sub.authorUserId,
            url ? `你投给官号的稿子已通过并发出 ✓\n${url}` : `你投给官号的稿子已通过，会在 ${when?.toLocaleString("zh-CN")} 用 @${handle} 发出。`,
          );
        }
        return Response.json({ item: (await views([sub]))[0] });
      }
      case "reject": {
        const sub = await reject(user.id, b.id, b.reason);
        if (sub.authorUserId !== user.id) await tell(sub.authorUserId, `你投给官号的稿子被驳回了${sub.rejectReason ? `：${sub.rejectReason}` : "。"}`);
        break;
      }
      case "withdraw":
        await withdraw(user.id, b.id);
        break;
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof TeamPublishError) return Response.json({ error: e.message, needTopup: e.balance }, { status: e.balance ? 402 : 422 });
    if (e instanceof InsufficientBalanceError) return Response.json({ error: e.message, needTopup: true }, { status: 402 });
    if (e instanceof TeamError || e instanceof PublishError) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
