import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { hashPassword, startSession } from "@/lib/auth";
import { attachReferral } from "@/lib/rewards";
import { clientIp, fmtWait, hitAll, tooMany } from "@/lib/rate-limit";

const Body = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  name: z.string().trim().max(50).optional(),
  // 朋友的邀请码（注册页链接 ?ref=邀请码）
  ref: z.string().trim().max(40).optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "请填写有效的邮箱，密码至少 8 位" }, { status: 400 });
  }
  const { email, password, name, ref } = parsed.data;
  // 防批量注册（每个新号可能有赠送余额）：同一个来源每小时最多 5 个、每天最多 20 个
  const ip = clientIp(request);
  const r = hitAll([
    { key: `signup:h:${ip}`, limit: 5, windowMs: 3600_000 },
    { key: `signup:d:${ip}`, limit: 20, windowMs: 24 * 3600_000 },
  ]);
  if (!r.ok) return tooMany(`注册太频繁了，请 ${fmtWait(r.retryAfterMs)}后再试`, r.retryAfterMs);
  const db = await getDb();
  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (existing.length) {
    return Response.json({ error: "这个邮箱已经注册过了，请直接登录" }, { status: 409 });
  }
  const [user] = await db
    .insert(schema.users)
    .values({ email, name: name || null, passwordHash: await hashPassword(password) })
    .returning({ id: schema.users.id });
  // 新用户赠送不在这里发：换个邮箱就能再注册一个号。改成
  // TG 和 X 都绑好后才送，每个 TG 号、X 账号只送一次，见 lib/tg-gate.ts 的 grantNewUserBonus
  // 邀请码填错不影响注册
  if (ref) await attachReferral(user.id, ref, "web").catch(() => null);
  await startSession(user.id);
  return Response.json({ ok: true });
}
