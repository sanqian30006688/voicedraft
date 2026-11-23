import { requireUser } from "@/lib/auth";
import { listPeople, summary, type Tab } from "@/lib/follow-check";

const TABS: Tab[] = ["nofollow", "lost", "ignored"];

/** 互关检测：概况 + 一页名单（?tab=nofollow|lost|ignored&blue=1&q=&page=） */
export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const u = new URL(request.url);
  const tab = (TABS as string[]).includes(u.searchParams.get("tab") ?? "") ? (u.searchParams.get("tab") as Tab) : "nofollow";
  const [s, list] = await Promise.all([
    summary(user.id),
    listPeople(user.id, {
      tab,
      blueOnly: u.searchParams.get("blue") === "1",
      q: (u.searchParams.get("q") ?? "").slice(0, 30),
      page: Number(u.searchParams.get("page")) || 0,
      size: 50,
    }),
  ]);
  return Response.json({ summary: s, tab, ...list });
}
