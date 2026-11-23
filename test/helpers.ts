import { getDb, schema } from "@/db";
import { POST as signup } from "@/app/api/auth/signup/route";

const jar = (globalThis as unknown as { __testJar: Map<string, string> }).__testJar;
export const tgSent = (globalThis as unknown as { __tgSent: { method: string; params: Record<string, unknown> }[] }).__tgSent;

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

let ipSeq = 0;

/** 走真实的注册接口建一个顾客，返回他的登录 cookie */
export async function createUser(email: string): Promise<TestUser> {
  jar.clear();
  // 每个测试顾客当作来自不同的网络，免得撞上「同一来源注册太多」的限制
  const req = json({ email, password: "password-123" });
  req.headers.set("x-forwarded-for", `10.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}.1`);
  const res = await signup(req);
  if (res.status !== 200) throw new Error(`注册失败 ${res.status} ${await res.text()}`);
  const cookie = jar.get("vd_session")!;
  const db = await getDb();
  const all = await db.select().from(schema.users);
  const u = all.find((x) => x.email === email)!;
  return { id: u.id, email, cookie };
}

/** 切换当前登录的人（null = 未登录） */
export function loginAs(user: TestUser | null) {
  jar.clear();
  if (user) jar.set("vd_session", user.cookie);
}

export function json(body: unknown, url = "http://localhost:3000/api/test", method = "POST") {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export const get = (url = "http://localhost:3000/api/test") => new Request(url);
export const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
export const body = async (res: Response) => res.json() as Promise<Record<string, unknown> & { items?: unknown[] }>;
