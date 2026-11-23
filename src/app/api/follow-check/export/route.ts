import { requireUser } from "@/lib/auth";
import { exportCsv, type Tab } from "@/lib/follow-check";

const TABS: Tab[] = ["nofollow", "lost", "ignored"];

/** 导出名单（CSV）：?tab= 不传时导出未回关 + 取关了我 */
export async function GET(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const t = new URL(request.url).searchParams.get("tab") ?? "";
  const csv = await exportCsv(user.id, (TABS as string[]).includes(t) ? (t as Tab) : undefined);
  const day = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="follow-check-${day}.csv"; filename*=UTF-8''${encodeURIComponent(`互关检测-${day}.csv`)}`,
    },
  });
}
