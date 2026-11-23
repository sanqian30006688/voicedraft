/**
 * 用户编号 + 后台「用户」页：编号从 10001 起递增、机器人余额里能看到编号；
 * 只有管理员能搜人、看详情、改余额、发消息；按编号 / TG @用户名 / 邮箱 / X 账号都能找到；
 * 手动充值算收入，调整不算；原因必填，明细里记下是哪位管理员；发消息走机器人。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getBalance, getConfig, saveConfig } from "@/lib/billing";
import { resetRateLimits } from "@/lib/rate-limit";
import { handleUpdate, type TgUpdate } from "@/lib/telegram";
import { parseQuery } from "@/lib/users-admin";
import * as bindRoute from "@/app/api/telegram/bind/route";
import * as listRoute from "@/app/api/admin/users/route";
import * as detailRoute from "@/app/api/admin/users/[id]/route";
import * as messageRoute from "@/app/api/admin/users/[id]/message/route";
import * as meRoute from "@/app/api/me/route";
import { body, createUser, ctx, get, json, loginAs, tgSent, type TestUser } from "./helpers";

let seq = 1;
function message(chat: number, text: string, from: Record<string, unknown> = {}): TgUpdate {
  return {
    update_id: 70_000 + seq++,
    message: { message_id: seq, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "private" }, from: { id: chat, ...from }, text },
  } as TgUpdate;
}
const textsTo = (chat: number) => tgSent.filter((x) => x.method === "sendMessage" && String(x.params.chat_id) === String(chat)).map((x) => String(x.params.text));

async function bind(u: TestUser, chat: number, from: Record<string, unknown>) {
  loginAs(u);
  const r = await body(await bindRoute.POST());
  const code = new URL(r.url as string).searchParams.get("start")!;
  await handleUpdate(message(chat, `/start ${code}`, from));
}

const search = async (q: string) => body(await listRoute.GET(get(`http://localhost:3000/api/admin/users?q=${encodeURIComponent(q)}`))) as Promise<{ rows: { id: string; no: number }[]; total: number }>;

const ALICE = { username: "Alice_TG", first_name: "Alice" };
let ADMIN: TestUser, A: TestUser, B: TestUser;
beforeAll(async () => {
  ADMIN = await createUser("ua-admin@example.com"); // 最早注册的是管理员
  A = await createUser("alice@example.com");
  B = await createUser("bob@example.com");
  await saveConfig({ ...(await getConfig()), enabled: true, signupBonus: 0 });
  await bind(A, 9101, ALICE);
  const db = await getDb();
  await db.insert(schema.xAccounts).values({
    userId: B.id,
    xUserId: "x-bob",
    handle: "bob_on_x",
    scopes: "tweet.read",
    accessTokenEnc: "x",
    expiresAt: new Date(Date.now() + 3600_000),
  });
});
beforeEach(() => {
  resetRateLimits();
  tgSent.length = 0;
});

const noOf = async (u: TestUser) => {
  const db = await getDb();
  const [r] = await db.select({ n: schema.users.userNo }).from(schema.users).where(eq(schema.users.id, u.id));
  return r.n;
};

describe("用户编号", () => {
  it("从 10001 起按注册顺序递增，不重复", async () => {
    expect(await noOf(ADMIN)).toBe(10001);
    expect(await noOf(A)).toBe(10002);
    expect(await noOf(B)).toBe(10003);
  });

  it("机器人「余额」里显示编号，还有一键复制；/id 也能查", async () => {
    await handleUpdate(message(9101, "/balance", ALICE));
    const last = tgSent.filter((x) => x.method === "sendMessage").at(-1)!;
    expect(String(last.params.text)).toContain("用户编号：10002");
    expect(JSON.stringify(last.params.reply_markup)).toContain('"copy_text":{"text":"10002"}');
    await handleUpdate(message(9101, "/id", ALICE));
    expect(textsTo(9101).at(-1)).toContain("10002");
  });

  it("网页账号信息里也有编号", async () => {
    loginAs(A);
    const me = await body(await meRoute.GET());
    expect((me.user as { no: number }).no).toBe(10002);
  });

  it("记下 TG 的 @用户名，改名后跟着更新", async () => {
    const db = await getDb();
    let [b] = await db.select().from(schema.tgBindings).where(eq(schema.tgBindings.userId, A.id));
    expect(b.tgUsername).toBe("Alice_TG");
    expect(b.tgName).toBe("Alice");
    await handleUpdate(message(9101, "/balance", { username: "alice_new", first_name: "Alice", last_name: "W" }));
    [b] = await db.select().from(schema.tgBindings).where(eq(schema.tgBindings.userId, A.id));
    expect(b.tgUsername).toBe("alice_new");
    expect(b.tgName).toBe("Alice W");
  });
});

describe("后台找人", () => {
  it("搜索框能认出编号、@用户名、t.me 链接", () => {
    expect(parseQuery("10023")).toEqual({ kind: "no", no: 10023 });
    expect(parseQuery("#10023")).toEqual({ kind: "no", no: 10023 });
    expect(parseQuery("编号：10023")).toEqual({ kind: "no", no: 10023 });
    expect(parseQuery("@abc_1")).toEqual({ kind: "tg", name: "abc_1" });
    expect(parseQuery("https://t.me/abc_1")).toEqual({ kind: "tg", name: "abc_1" });
    expect(parseQuery("a@b.com")).toEqual({ kind: "text", text: "a@b.com" });
    expect(parseQuery("  ")).toBeNull();
  });

  it("不是管理员：搜人、看详情、改余额、发消息都不行", async () => {
    loginAs(A);
    expect((await listRoute.GET(get("http://localhost:3000/api/admin/users?q="))).status).toBe(403);
    expect((await detailRoute.GET(get(), ctx(B.id))).status).toBe(403);
    expect((await messageRoute.POST(json({ text: "hi" }), ctx(B.id))).status).toBe(403);
    loginAs(null);
    expect((await listRoute.GET(get("http://localhost:3000/api/admin/users?q="))).status).toBe(401);
  });

  it("按编号、TG @用户名、邮箱、X 账号都能找到", async () => {
    loginAs(ADMIN);
    expect((await search("10003")).rows.map((r) => r.id)).toEqual([B.id]);
    expect((await search("@ALICE_NEW")).rows.map((r) => r.id)).toEqual([A.id]);
    expect((await search("alice@")).rows.map((r) => r.id)).toEqual([A.id]);
    expect((await search("@bob_on_x")).rows.map((r) => r.id)).toEqual([B.id]);
    expect((await search("bob_on")).rows.map((r) => r.id)).toEqual([B.id]);
    expect((await search("9101")).rows).toEqual([]); // 9101 当编号找，没有这个编号
    expect((await search("%")).rows).toEqual([]); // 通配符不会列出所有人
    const all = await search("");
    expect(all.total).toBe(3);
    expect(all.rows[0].id).toBe(B.id); // 最新注册的排前面
  });
});

describe("后台改余额、发消息", () => {


  it("发消息走机器人，开头标明是客服消息；没绑 TG 的发不了", async () => {
    loginAs(ADMIN);
    expect((await messageRoute.POST(json({ text: "你好，充值已处理" }), ctx(A.id))).status).toBe(200);
    expect(textsTo(9101).at(-1)).toBe("📮 客服消息\n\n你好，充值已处理");
    const r = await messageRoute.POST(json({ text: "hi" }), ctx(B.id));
    expect(r.status).toBe(422);
    expect(String((await body(r)).error)).toContain("没绑定 TG");
  });

  it("不存在的用户：404 / 422，不会建出钱包", async () => {
    loginAs(ADMIN);
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect((await detailRoute.GET(get(), ctx(ghost))).status).toBe(404);
    expect((await detailRoute.GET(get(), ctx("not-a-uuid"))).status).toBe(404);
  });
});
