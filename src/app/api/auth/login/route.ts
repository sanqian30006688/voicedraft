import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { startSession, verifyPassword } from "@/lib/auth";
import { clientIp, count, fmtWait, hit, tooMany } from "@/lib/rate-limit";

// 防撞库：同一个来源 15 分钟最多试 30 次；同一个邮箱 15 分钟输错 10 次就先锁住
const WINDOW = 15 * 60_000;
const PER_IP = 30;
const FAILS_PER_EMAIL = 10;

const Body = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请填写邮箱和密码" }, { status: 400 });
  const { email, password } = parsed.data;
  const ip = hit(`login:ip:${clientIp(request)}`, PER_IP, WINDOW);
  if (!ip.ok) return tooMany(`登录尝试太频繁了，请 ${fmtWait(ip.retryAfterMs)}后再试`, ip.retryAfterMs);
  const failKey = `login:fail:${email}`;
  if (count(failKey, WINDOW) >= FAILS_PER_EMAIL) {
    return tooMany("这个邮箱密码输错太多次，已暂时锁定，请 15 分钟后再试", WINDOW);
  }
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    hit(failKey, FAILS_PER_EMAIL, WINDOW);
    return Response.json({ error: "邮箱或密码不对" }, { status: 401 });
  }
  await startSession(user.id);
  return Response.json({ ok: true });
}
