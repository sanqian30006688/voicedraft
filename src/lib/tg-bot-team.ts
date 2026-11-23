import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getConfig } from "./billing";
import { editButtons, sendMessage, type Keyboard } from "./tg-api";
import { clearAwait, clip, fmtTime, getState, sendErr, setState, tweetUrl } from "./tg-bot-core";
import {
  approve,
  createInvite,
  createTeam,
  displayName,
  editSubmission,
  getSubmission,
  joinTeam,
  leaveTeam,
  listSubmissions,
  myTeam,
  officialHandle,
  overview,
  previewInvite,
  reject,
  reviewerIds,
  ROLE_LABEL,
  STATUS_LABEL,
  submit,
  TeamError,
  withdraw,
  type SubmissionRow,
} from "./team";
import { weightedLength } from "./text";

/**
 * 机器人里的团队：看团队和额度、发邀请链接、加入 / 退出；
 * 成员投稿给官号，所有者 / 管理员收到审批卡片：立即发、定时、改一下、驳回。
 */

export async function chatOf(userId: string): Promise<string | null> {
  const db = await getDb();
  const [b] = await db.select({ chatId: schema.tgBindings.chatId }).from(schema.tgBindings).where(eq(schema.tgBindings.userId, userId)).limit(1);
  return b?.chatId ?? null;
}

async function tell(userId: string, text: string, buttons?: Keyboard) {
  const chat = await chatOf(userId);
  if (chat) await sendMessage(chat, text, buttons ? { buttons } : {}).catch(() => {});
}

const body = (tweets: string[]) => (tweets.length > 1 ? tweets.map((t, i) => `【${i + 1}】\n${t}`).join("\n\n") : tweets[0]);

function reviewButtons(id: string): Keyboard {
  return [
    [
      { text: "✅ 通过，立即发", callback_data: `tma:${id}` },
      { text: "⏰ 通过，定时", callback_data: `tms:${id}` },
    ],
    [
      { text: "✏️ 改一下", callback_data: `tme:${id}` },
      { text: "❌ 驳回", callback_data: `tmr:${id}` },
    ],
  ];
}

async function reviewCardText(sub: SubmissionRow) {
  const t = await myTeamOf(sub);
  return `📮 ${await displayName(sub.authorUserId)} 投稿给官号${t ? ` @${t}` : ""}${sub.tweets.length > 1 ? `（串推 ${sub.tweets.length} 条）` : ""}：\n\n${clip(body(sub.tweets), 3300)}${
    sub.note ? `\n\n备注：${sub.note}` : ""
  }`;
}

async function myTeamOf(sub: SubmissionRow): Promise<string | null> {
  const db = await getDb();
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, sub.teamId)).limit(1);
  return team ? officialHandle(team) : null;
}

/** 新投稿：发审批卡片给所有者和管理员（作者自己是审批人时也发给他，方便直接点） */
export async function notifyReviewers(sub: SubmissionRow) {
  const text = await reviewCardText(sub);
  for (const id of await reviewerIds(sub.teamId)) await tell(id, text, reviewButtons(sub.id));
}

async function notifyAuthor(sub: SubmissionRow, text: string, byUserId: string) {
  if (sub.authorUserId === byUserId) return;
  await tell(sub.authorUserId, text);
}

// ---------- 团队页 ----------

export async function showTeam(userId: string, chatId: string) {
  const o = await overview(userId);
  if (!o) {
    const { teamMinBalance } = await getConfig();
    await sendMessage(
      chatId,
      "👥 团队\n\n你还不在团队里。建一个团队后，可以把邀请链接发给同事或朋友：\n" +
        "· 大家共用你的余额，你给每个人设每天 / 每月上限\n" +
        "· 你把自己连接的 X 设为官号，成员写好稿子投给官号，你在这里点「通过」才发出\n" +
        "· 每个人的素材、风格卡、草稿还是各自的，你只看得到每人花了多少\n\n" +
        `建团队和邀请成员需要你的余额不低于 ${teamMinBalance} USDT。\n` +
        "收到别人的邀请链接，直接点开就能加入。",
      { buttons: [[{ text: "➕ 新建团队", callback_data: "tmc" }]] },
    );
    return;
  }
  const lines = [`👥 ${o.name}（你是${ROLE_LABEL[o.role]}）`, ""];
  if (o.balance != null) lines.push(`团队余额：${o.balance} USDT（所有者 ${o.ownerName} 的余额）`);
  if (o.role !== "owner") {
    const lim = [o.me.daily ? `每天 ${o.me.daily}` : null, o.me.monthly ? `每月 ${o.me.monthly}` : null].filter(Boolean).join("、");
    lines.push(`你的额度：${lim || "不限"}；今天用了 ${o.me.usedToday}，本月 ${o.me.usedMonth} USDT`);
    lines.push(o.fallbackPersonal ? "额度用完后改扣你自己的余额。" : "额度用完就先停，找所有者加额度。");
  }
  if (o.paused) {
    lines.push(
      o.role === "owner"
        ? `⚠️ 你的余额低于 ${o.minBalance} USDT，成员暂时不能共用，也不能邀请新成员。充值后自动恢复。`
        : `⚠️ 团队余额低于 ${o.minBalance} USDT，共用已暂停${o.fallbackPersonal ? "，现在扣你自己的余额" : ""}。所有者充值后自动恢复。`,
    );
  }
  lines.push(o.official ? `官号：${o.official.handle ? `@${o.official.handle}` : "（X 授权失效了）"}，由 ${o.official.holderName} 连接` : "官号：还没设置");
  if (o.members) {
    lines.push("", `成员 ${o.members.length} 人：`);
    for (const m of o.members) {
      const lim = [m.daily ? `每天 ${m.daily}` : null, m.monthly ? `每月 ${m.monthly}` : null].filter(Boolean).join("、");
      lines.push(`· ${m.name}（${ROLE_LABEL[m.role]}）${m.role === "owner" ? "" : ` 今天 ${m.usedToday} / 本月 ${m.usedMonth}${lim ? `，上限 ${lim}` : ""}`}`);
    }
    lines.push("", "改上限、移出成员请到网页「团队」页。");
  }
  const reviewer = o.role !== "member";
  const buttons: Keyboard = [
    [
      ...(o.official ? [{ text: "📮 投稿给官号", callback_data: "tmsub" }] : []),
      { text: "我的投稿", callback_data: "tmm" },
    ],
  ];
  if (reviewer) {
    buttons.push([
      { text: `📋 待审批${o.pendingCount ? `（${o.pendingCount}）` : ""}`, callback_data: "tmp" },
      { text: "🔗 邀请链接", callback_data: "tmi" },
    ]);
  }
  if (o.role === "member" || o.role === "admin") buttons.push([{ text: "退出团队", callback_data: "tml" }]);
  await sendMessage(chatId, lines.join("\n"), { buttons });
}

async function sendInvite(userId: string, chatId: string) {
  const { code, expiresAt } = await createInvite(userId);
  // 动态引入，避免和 telegram.ts 互相引用
  const { botUsername } = await import("./telegram");
  const username = await botUsername();
  const t = await myTeam(userId);
  await sendMessage(
    chatId,
    `把下面这条转发给同事或朋友，点开链接就能加入「${t?.team.name ?? "团队"}」（${fmtTime(expiresAt)} 前有效）。\n` +
      "对方需要先有 VoiceDraft 账号并绑定 TG；还没有的话，也可以在网页「团队」页填邀请码：" +
      code,
  );
  await sendMessage(chatId, `邀请你加入我的 VoiceDraft 团队：\nhttps://t.me/${username}?start=team_${code}`);
}

/** TG 的 start=team_邀请码：先给用户看是哪个团队，点了才加入 */
export async function handleTeamStart(userId: string | null, chatId: string, code: string) {
  const p = await previewInvite(code);
  if (!p) {
    await sendMessage(chatId, "这个团队邀请链接已过期或已作废，请找发链接的人重新发一个。");
    return;
  }
  if (!userId) {
    await sendMessage(
      chatId,
      `${p.ownerName} 邀请你加入团队「${p.teamName}」。\n\n你还没有绑定 VoiceDraft 账号：请先在 VoiceDraft 网页注册，点「绑定 TG」，绑定好后再点一次邀请链接。也可以在网页「团队」页填邀请码：${code}`,
    );
    return;
  }
  await sendMessage(chatId, `${p.ownerName} 邀请你加入团队「${p.teamName}」。\n加入后你用的功能会先从团队余额里扣（在所有者给你的额度内），你的素材、风格卡、草稿仍然只有你自己看得到。`, {
    buttons: [
      [
        { text: "✅ 加入", callback_data: `tmj:${code}` },
        { text: "不加入", callback_data: "noop:cancel" },
      ],
    ],
  });
}

// ---------- 投稿 ----------

/** 从文字投稿：一条消息就是一条帖子；空一行再写「---」分隔的话当串推 */
function parseTweets(text: string): string[] {
  const parts = text
    .split(/\n\s*-{3,}\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

export async function submitAndNotify(userId: string, chatId: string, tweets: string[], note?: string) {
  try {
    const sub = await submit(userId, tweets, note);
    await notifyReviewers(sub);
    const t = await myTeam(userId);
    if (t && t.link.role === "member") await sendMessage(chatId, "已投给官号 ✓ 所有者或管理员通过后会发出，结果会通知你。");
    else await sendMessage(chatId, "已投给官号 ✓ 审批卡片已发出（你也能审批）。");
  } catch (e) {
    await sendErr(chatId, e);
  }
}

async function showMine(userId: string, chatId: string) {
  const rows = await listSubmissions(userId, "mine", 10);
  if (!rows.length) {
    await sendMessage(chatId, "你还没有投过稿。");
    return;
  }
  const lines = ["我的投稿（最近 10 篇）：", ""];
  for (const s of rows) lines.push(`· ${STATUS_LABEL[s.status] ?? s.status}  ${clip(s.tweets[0], 40)}${s.rejectReason ? `（${s.rejectReason}）` : ""}`);
  const pending = rows.filter((s) => s.status === "pending");
  await sendMessage(chatId, lines.join("\n"), {
    buttons: pending.length ? [pending.slice(0, 5).map((s, i) => ({ text: `撤回 ${i + 1}`, callback_data: `tmw:${s.id}` }))] : undefined,
  });
}

async function showPending(userId: string, chatId: string) {
  const rows = await listSubmissions(userId, "pending", 10);
  if (!rows.length) {
    await sendMessage(chatId, "现在没有等审批的投稿。");
    return;
  }
  for (const s of rows.reverse()) await sendMessage(chatId, await reviewCardText(s), { buttons: reviewButtons(s.id) });
}

async function doApprove(userId: string, chatId: string, id: string, mid: number, when: Date | null) {
  await editButtons(chatId, mid, [[{ text: when ? "排进定时中…" : "发布中…", callback_data: "noop" }]]);
  try {
    const { sub, post, handle } = await approve(userId, id, when);
    const reviewer = await displayName(userId);
    if (when) {
      await editButtons(chatId, mid, [[{ text: `已通过，${fmtTime(when)} 用 @${handle} 发 ✓`, callback_data: "noop" }]]);
      await notifyAuthor(sub, `你投给官号的稿子 ${reviewer} 已通过，会在 ${fmtTime(when)} 用 @${handle} 发出：\n${clip(sub.tweets[0], 80)}`, userId);
    } else {
      const url = tweetUrl(handle, post.postIds[0]);
      await editButtons(chatId, mid, [[{ text: `已通过并发出 ✓`, callback_data: "noop" }]]);
      await sendMessage(chatId, `已用 @${handle} 发出 ✓\n${url}`);
      await notifyAuthor(sub, `你投给官号的稿子 ${reviewer} 已通过并发出 ✓\n${url}`, userId);
    }
  } catch (e) {
    await editButtons(chatId, mid, e instanceof TeamError && e.message.includes("处理过") ? [] : reviewButtons(id));
    // 余额不足等：sendErr 会带上「去充值」按钮
    await sendErr(chatId, e);
  }
}

async function doReject(userId: string, chatId: string, id: string, reason?: string) {
  try {
    const sub = await reject(userId, id, reason);
    await sendMessage(chatId, "已驳回。");
    await notifyAuthor(sub, `你投给官号的稿子被 ${await displayName(userId)} 驳回了${sub.rejectReason ? `：${sub.rejectReason}` : "。"}\n${clip(sub.tweets[0], 80)}`, userId);
  } catch (e) {
    await sendErr(chatId, e);
  }
}

// ---------- 入口 ----------

/** /team、/submit；返回 true 表示已处理 */
export async function handleTeamMenu(userId: string, chatId: string, cmd: string, rest: string): Promise<boolean> {
  if (cmd === "/team") {
    await clearAwait(userId);
    await showTeam(userId, chatId);
    return true;
  }
  if (cmd === "/submit") {
    if (rest) await submitAndNotify(userId, chatId, parseTweets(rest));
    else await askSubmit(userId, chatId);
    return true;
  }
  return false;
}

async function askSubmit(userId: string, chatId: string) {
  const t = await myTeam(userId);
  if (!t) throw new TeamError("你还不在任何团队里");
  const handle = await officialHandle(t.team);
  if (!handle) throw new TeamError("团队还没有设置官号（或官号的 X 授权失效了）");
  await setState(userId, { await: { kind: "team_submit" } });
  await sendMessage(
    chatId,
    `把要投给官号 @${handle} 的内容发给我。\n一条消息就是一条帖子；要投串推，在每条之间单独一行写 ---。\n也可以在草稿卡片上点「📮 投给官号」。发 /cancel 取消。`,
  );
}

/** 正在等投稿、改稿、驳回理由、团队名字；返回 true 表示已处理 */
export async function handleTeamAwait(userId: string, chatId: string, text: string): Promise<boolean> {
  const { await: waiting } = await getState(userId);
  switch (waiting?.kind) {
    case "team_submit": {
      const tweets = parseTweets(text);
      const over = tweets.findIndex((t) => !weightedLength(t).valid);
      if (over >= 0) {
        await sendMessage(chatId, `${tweets.length > 1 ? `第 ${over + 1} 条` : "这条"}超过 280 加权字数了，改短一点再发；长内容可以用 ---- 分成串推。发 /cancel 取消。`);
        return true;
      }
      await clearAwait(userId);
      await submitAndNotify(userId, chatId, tweets);
      return true;
    }
    case "team_edit": {
      await clearAwait(userId);
      try {
        const sub = await editSubmission(userId, waiting.subId, parseTweets(text));
        await sendMessage(chatId, `${await reviewCardText(sub)}\n\n（已按你的修改更新）`, { buttons: reviewButtons(sub.id) });
      } catch (e) {
        await sendErr(chatId, e);
      }
      return true;
    }
    case "team_reject": {
      await clearAwait(userId);
      await doReject(userId, chatId, waiting.subId, text.trim() === "/skip" ? undefined : text);
      return true;
    }
    case "team_name": {
      await clearAwait(userId);
      try {
        const t = await createTeam(userId, text);
        await sendMessage(chatId, `团队「${t.name}」建好了 ✓`);
        await showTeam(userId, chatId);
      } catch (e) {
        await sendErr(chatId, e);
      }
      return true;
    }
  }
  return false;
}

/** 团队相关的按钮；返回 null 表示不是这里的按钮 */
export async function handleTeamCallback(
  userId: string,
  chatId: string,
  action: string,
  a: string,
  b: string,
  mid: number,
  presetTime: (p: string) => Date | null,
): Promise<string | undefined | null> {
  try {
    switch (action) {
      case "tm":
        await showTeam(userId, chatId);
        return;
      case "tmc":
        await setState(userId, { await: { kind: "team_name" } });
        await sendMessage(chatId, "给团队起个名字（例如公司或项目名）。发 /cancel 取消。");
        return;
      case "tmj": {
        const t = await joinTeam(userId, a);
        await editButtons(chatId, mid, [[{ text: "已加入 ✓", callback_data: "noop" }]]);
        await tell(t.ownerUserId, `${await displayName(userId)} 加入了团队「${t.name}」。可以在网页「团队」页给他设额度。`);
        await showTeam(userId, chatId);
        return;
      }
      case "tml":
        await sendMessage(chatId, "确定退出团队？退出后用的功能只扣你自己的余额，还没审批的投稿会撤回。", {
          buttons: [
            [
              { text: "确定退出", callback_data: "tmlok" },
              { text: "取消", callback_data: "noop:cancel" },
            ],
          ],
        });
        return;
      case "tmlok": {
        const t = await myTeam(userId);
        await leaveTeam(userId);
        await editButtons(chatId, mid, [[{ text: "已退出团队", callback_data: "noop" }]]);
        if (t) await tell(t.team.ownerUserId, `${await displayName(userId)} 退出了团队「${t.team.name}」。`);
        return;
      }
      case "tmi":
        await sendInvite(userId, chatId);
        return;
      case "tmsub":
        await askSubmit(userId, chatId);
        return;
      case "tmm":
        await showMine(userId, chatId);
        return;
      case "tmp":
        await showPending(userId, chatId);
        return;
      case "tmw":
        await withdraw(userId, a);
        await sendMessage(chatId, "已撤回。");
        return;
      case "tma":
        await doApprove(userId, chatId, a, mid, null);
        return;
      case "tms":
        await getSubmission(userId, a);
        await editButtons(chatId, mid, [
          [
            { text: "1 小时后", callback_data: `tmt:${a}:1h` },
            { text: "3 小时后", callback_data: `tmt:${a}:3h` },
          ],
          [
            { text: "今晚 21:00", callback_data: `tmt:${a}:21` },
            { text: "明早 9:00", callback_data: `tmt:${a}:9` },
          ],
          [{ text: "返回", callback_data: `tmb:${a}` }],
        ]);
        return;
      case "tmt": {
        const when = presetTime(b);
        if (!when) return "这个时间选项失效了";
        await doApprove(userId, chatId, a, mid, when);
        return;
      }
      case "tmb":
        await editButtons(chatId, mid, reviewButtons(a));
        return;
      case "tme": {
        const { sub } = await getSubmission(userId, a);
        if (sub.status !== "pending") return "这篇已经处理过了";
        await setState(userId, { await: { kind: "team_edit", subId: a } });
        await sendMessage(chatId, `把改好的内容发给我（可以复制下面的再改）${sub.tweets.length > 1 ? "，串推每条之间单独一行写 ---" : ""}。发 /cancel 取消。`);
        await sendMessage(chatId, sub.tweets.join("\n---\n"));
        return;
      }
      case "tmr": {
        const { sub } = await getSubmission(userId, a);
        if (sub.status !== "pending") return "这篇已经处理过了";
        await setState(userId, { await: { kind: "team_reject", subId: a } });
        await editButtons(chatId, mid, []);
        await sendMessage(chatId, "驳回的理由是什么？会告诉投稿人。不想写就发 /skip。");
        return;
      }
    }
  } catch (e) {
    if (e instanceof TeamError) return clip(e.message, 190);
    await sendErr(chatId, e);
    return;
  }
  return null;
}

/** 草稿卡片上要不要显示「投给官号」：在团队里、团队有官号、官号不是自己 */
export async function canSubmitToOfficial(userId: string): Promise<boolean> {
  const t = await myTeam(userId);
  return !!t?.team.officialUserId && t.team.officialUserId !== userId;
}

/** 团队余额一行（TG「💰 余额」里显示） */
export async function teamWalletLine(userId: string): Promise<string | null> {
  const o = await overview(userId);
  if (!o || o.role === "owner") return o ? `你是团队「${o.name}」的所有者，成员也从你的余额里扣（在你给的额度内）。` : null;
  const lim = [o.me.daily ? `每天 ${o.me.daily}` : null, o.me.monthly ? `每月 ${o.me.monthly}` : null].filter(Boolean).join("、");
  return `👥 团队「${o.name}」：你用的功能先扣团队余额。额度 ${lim || "不限"}，今天用了 ${o.me.usedToday}，本月 ${o.me.usedMonth} USDT${
    o.me.left != null ? `，还剩 ${o.me.left}` : ""
  }。${o.fallbackPersonal ? "用完后扣你自己的余额。" : "用完就先停。"}${o.paused ? `\n⚠️ 团队余额低于 ${o.minBalance} USDT，共用已暂停，所有者充值后自动恢复。` : ""}`;
}

