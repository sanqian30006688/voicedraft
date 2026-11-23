/**
 * 团队：共用钱包（成员在上限内扣所有者的余额）、邀请加入、官号投稿和审批，以及团队之间、团队内外的隔离。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addBalance, getBalance, ledgerLabel, MICRO, recentLedger, reserve, refund, InsufficientBalanceError } from "@/lib/billing";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { resetRateLimits } from "@/lib/rate-limit";
import { createInvite, createTeam, joinTeam, revokeInvites, setOfficial, approve, TeamError, updateMember, updateTeamSettings } from "@/lib/team";
import { connectMock } from "@/lib/x";
import * as teamRoute from "@/app/api/team/route";
import * as generateRoute from "@/app/api/generate/route";
import { body, createUser, get, json, loginAs, tgSent, type TestUser } from "./helpers";

let OWNER: TestUser; // 团队所有者，官号是他连接的 X
let M: TestUser; // 普通成员
let N: TestUser; // 用 TG 邀请链接加入的成员
let OUT: TestUser; // 另一个团队的所有者
let STRANGER: TestUser; // 不在任何团队

const CHAT = { owner: 501, m: 502, n: 503, out: 504, stranger: 505 };
let seq = 1;
const message = (chat: number, text: string): TgUpdate =>
  ({ update_id: seq++, message: { message_id: seq, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "private" }, text } }) as TgUpdate;
const press = (chat: number, data: string): TgUpdate =>
  ({ update_id: seq++, callback_query: { id: String(seq), data, message: { message_id: 1, chat: { id: chat, type: "private" } } } }) as unknown as TgUpdate;
const textsTo = (chat: number) =>
  tgSent.filter((x) => String(x.params.chat_id) === String(chat)).map((x) => JSON.stringify(x.params)).join("\n");

const U = (n: number) => Math.round(n * MICRO);
const gen = () => generateRoute.POST(json({ task: { kind: "full", topic: "测试", count: 1 } }));
const team = async (b: unknown) => teamRoute.POST(json(b));
const teamGet = async (url = "http://localhost:3000/api/team") => body(await teamRoute.GET(get(url)));

async function bind(user: TestUser, chat: number) {
  const db = await getDb();
  await db.insert(schema.tgBindings).values({ userId: user.id, chatId: String(chat), boundAt: new Date() });
}

async function setPersonal(user: TestUser, usdt: number) {
  await addBalance(user.id, U(usdt) - (await getBalance(user.id)), { kind: "adjust", note: "测试" });
}

beforeAll(async () => {
  await createUser("platform@example.com"); // 最早注册的是平台方（管理员，不扣费）
  OWNER = await createUser("owner@example.com");
  M = await createUser("m@example.com");
  N = await createUser("n@example.com");
  OUT = await createUser("out@example.com");
  STRANGER = await createUser("stranger@example.com");
  const db = await getDb();
  const traits = { catchphrases: [], bannedWords: [], openings: "", stance: "", humor: "", topics: [], notes: "" };
  for (const u of [OWNER, M, N, OUT, STRANGER]) {
    await db.insert(schema.styleCards).values({ userId: u.id, lang: "zh", version: 1, traits, source: "generated" });
  }
  await bind(OWNER, CHAT.owner);
  await bind(M, CHAT.m);
  await bind(N, CHAT.n);
  await bind(OUT, CHAT.out);
  await bind(STRANGER, CHAT.stranger);
  await setPersonal(OWNER, 100);
  await setPersonal(OUT, 50);

  loginAs(OWNER);
  expect((await team({ action: "create", name: "星辰工作室" })).status).toBe(200);
  const inv = await createInvite(OWNER.id);
  await joinTeam(M.id, inv.code);
  loginAs(OUT);
  expect((await team({ action: "create", name: "别的团队" })).status).toBe(200);
  await setPersonal(OUT, 0);
});

beforeEach(() => resetRateLimits());

describe("隔离", () => {

  it("普通成员看不到团队余额、别的成员、所有者自己的流水", async () => {
    loginAs(M);
    const d = await teamGet();
    const t = d.team as { balance: unknown; members: unknown };
    expect(t.balance).toBeNull();
    expect(t.members).toBeNull();
    // 自己的余额页只有自己的流水
    const rows = await recentLedger(M.id);
    expect(rows.map((r) => ledgerLabel(r))).toEqual(expect.not.arrayContaining([expect.stringContaining("团队成员")]));
  });

  it("所有者看得到成员名单（开源版不计费，没有用量明细）", async () => {
    loginAs(OWNER);
    const d = await teamGet();
    const members = (d.team as { members: { email: string; usedToday: string }[] }).members;
    expect(members.map((m) => m.email).sort()).toEqual(["m@example.com", "owner@example.com"]);
  });

  it("一个人只能在一个团队里", async () => {
    await setPersonal(OUT, 30);
    const inv = await createInvite(OUT.id);
    await setPersonal(OUT, 0);
    await expect(joinTeam(M.id, inv.code)).rejects.toThrow(TeamError);
    await expect(joinTeam(OWNER.id, inv.code)).rejects.toThrow(TeamError);
  });

  it("普通成员不能设官号、发邀请、改额度", async () => {
    loginAs(M);
    await connectMock(M.id, "m-x");
    expect((await team({ action: "official", on: true })).status).toBe(422);
    expect((await team({ action: "invite" })).status).toBe(422);
    expect((await team({ action: "member", userId: M.id, daily: null })).status).toBe(422);
    const db = await getDb();
    await db.delete(schema.xAccounts).where(eq(schema.xAccounts.userId, M.id));
  });
});

describe("邀请", () => {
  it("TG 邀请链接：先确认再加入，所有者收到通知", async () => {
    const inv = await createInvite(OWNER.id);
    await handleUpdate(message(CHAT.n, `/start team_${inv.code}`));
    expect(textsTo(CHAT.n)).toContain("星辰工作室");
    const db = await getDb();
    expect(await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, N.id))).toHaveLength(0);
    await handleUpdate(press(CHAT.n, `tmj:${inv.code}`));
    expect(await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, N.id))).toHaveLength(1);
    expect(textsTo(CHAT.owner)).toContain("加入了团队");
  });

  it("作废后的邀请链接不能再用", async () => {
    const inv = await createInvite(OWNER.id);
    await revokeInvites(OWNER.id);
    await expect(joinTeam(STRANGER.id, inv.code)).rejects.toThrow("过期或已作废");
    await handleUpdate(message(CHAT.stranger, `/start team_${inv.code}`));
    expect(textsTo(CHAT.stranger)).toContain("过期或已作废");
  });
});

describe("官号投稿和审批", () => {
  let subId: string;

  it("所有者把自己的 X 设为官号", async () => {
    await connectMock(OWNER.id, "official");
    loginAs(OWNER);
    expect((await team({ action: "official", on: true })).status).toBe(200);
  });

  it("成员投稿后，所有者在 TG 收到审批卡片", async () => {
    loginAs(M);
    const res = await team({ action: "submit", tweets: ["团队第一条官号推文"] });
    expect(res.status).toBe(200);
    subId = ((await body(res)).item as { id: string }).id;
    expect(textsTo(CHAT.owner)).toContain(`tma:${subId}`);
    expect(textsTo(CHAT.m)).not.toContain(`tma:${subId}`);
  });

  it("别的团队、普通成员都不能审批", async () => {
    await expect(approve(OUT.id, subId)).rejects.toThrow(TeamError);
    await expect(approve(N.id, subId)).rejects.toThrow(TeamError);
    await expect(approve(STRANGER.id, subId)).rejects.toThrow(TeamError);
    loginAs(OUT);
    expect((await team({ action: "reject", id: subId })).status).toBe(422);
  });

  it("另一位成员看不到别人的投稿", async () => {
    loginAs(N);
    const d = await teamGet();
    expect(d.mine).toEqual([]);
    expect(d.pending).toEqual([]);
  });

  it("所有者在 TG 点「通过」：用官号发出，投稿人收到链接；再点一次不会发第二遍", async () => {
    const before = await getBalance(OWNER.id);
    await handleUpdate(press(CHAT.owner, `tma:${subId}`));
    const db = await getDb();
    const [sub] = await db.select().from(schema.teamSubmissions).where(eq(schema.teamSubmissions.id, subId));
    expect(sub.status).toBe("approved");
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, sub.postId!));
    expect(post.status).toBe("published");
    expect(post.userId).toBe(OWNER.id);
    expect(await getBalance(OWNER.id)).toBe(before); // 开源版不扣费
    expect(textsTo(CHAT.m)).toContain("已通过并发出");

    await handleUpdate(press(CHAT.owner, `tma:${subId}`));
    const posts = await db.select().from(schema.posts).where(eq(schema.posts.userId, OWNER.id));
    expect(posts).toHaveLength(1);
  });

  it("驳回时告诉投稿人理由", async () => {
    loginAs(M);
    const id = ((await body(await team({ action: "submit", tweets: ["这条会被驳回"] }))).item as { id: string }).id;
    await handleUpdate(press(CHAT.owner, `tmr:${id}`));
    await handleUpdate(message(CHAT.owner, "语气太随意了"));
    expect(textsTo(CHAT.m)).toContain("语气太随意了");
  });

  it("审批人可以先改再发，定时通过排进官号的队列", async () => {
    loginAs(M);
    const id = ((await body(await team({ action: "submit", tweets: ["原稿"] }))).item as { id: string }).id;
    loginAs(OWNER);
    expect((await team({ action: "edit", id, tweets: ["改过的稿"] })).status).toBe(200);
    const when = new Date(Date.now() + 3600_000).toISOString();
    expect((await team({ action: "approve", id, scheduledAt: when })).status).toBe(200);
    const db = await getDb();
    const [sub] = await db.select().from(schema.teamSubmissions).where(eq(schema.teamSubmissions.id, id));
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, sub.postId!));
    expect(post.status).toBe("scheduled");
    expect(post.tweets).toEqual(["改过的稿"]);
  });


  it("管理员只能拿自己的 X 当官号", async () => {
    await updateMember(OWNER.id, N.id, { role: "admin" });
    await expect(setOfficial(N.id, true)).rejects.toThrow("还没有连接 X");
    await connectMock(N.id, "n-x");
    await setOfficial(N.id, true);
    const db = await getDb();
    const [t] = await db.select().from(schema.teams).where(eq(schema.teams.ownerUserId, OWNER.id));
    expect(t.officialUserId).toBe(N.id);
  });

  it("退出团队后还没审批的投稿撤回", async () => {
    loginAs(M);
    const id = ((await body(await team({ action: "submit", tweets: ["退出前投的"] }))).item as { id: string }).id;
    expect((await team({ action: "leave" })).status).toBe(200);
    const db = await getDb();
    const [sub] = await db.select().from(schema.teamSubmissions).where(eq(schema.teamSubmissions.id, id));
    expect(sub.status).toBe("withdrawn");
  });
});

