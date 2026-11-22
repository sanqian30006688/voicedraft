/**
 * 互关检测的纯计算部分（不碰数据库、不调接口，方便测试）。
 */

export interface PersonInfo {
  id: string;
  handle: string;
  name: string | null;
  verifiedType: string | null;
  followers: number;
  following: number;
}

/** 上一次扫描存下的状态 */
export interface PrevRow {
  targetId: string;
  followsMe: boolean;
  lostAt: Date | null;
  ignored: boolean;
  unfollowedAt: Date | null;
}

export interface NextRow extends PersonInfo {
  iFollow: boolean;
  followsMe: boolean;
  lostAt: Date | null;
}

export interface DiffResult {
  /** 这次要写进去的行（新的、变了的、还要留着的） */
  upsert: NextRow[];
  /** 已经不相关了的行（不互相关注、也没取关我、也没忽略），删掉 */
  remove: string[];
  /** 这次新发现的「取关了我」 */
  newlyLost: number;
}

/**
 * 拿这次读到的「我关注的」和「关注我的」和上次的结果比：
 * - 上次是粉丝、这次不是了 → 取关了我（记 lostAt）；重新关注回来就清掉；
 * - 第一次扫描（没有上次）不算谁取关了我；
 * - 既不互相关注、也不是取关了我、也没被忽略的旧行删掉，免得越存越多。
 */
export function diffScan(following: PersonInfo[], followers: PersonInfo[], prev: PrevRow[], now: Date): DiffResult {
  const first = prev.length === 0;
  const before = new Map(prev.map((r) => [r.targetId, r]));
  const fo = new Map(following.map((p) => [p.id, p]));
  const fr = new Map(followers.map((p) => [p.id, p]));
  const upsert: NextRow[] = [];
  const remove: string[] = [];
  let newlyLost = 0;
  const seen = new Set<string>();
  for (const p of [...following, ...followers]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const old = before.get(p.id);
    const followsMe = fr.has(p.id);
    let lostAt: Date | null = null;
    if (!followsMe) {
      if (old?.followsMe && !first) {
        lostAt = now;
        newlyLost++;
      } else lostAt = old?.lostAt ?? null;
    }
    upsert.push({ ...(fo.get(p.id) ?? p), iFollow: fo.has(p.id), followsMe, lostAt });
  }
  for (const old of prev) {
    if (seen.has(old.targetId)) continue;
    // 这次两边都没有了：上次是粉丝 → 取关了我（我也没关注他）；之前就记过取关或忽略过的留着；其他的删掉
    if (old.followsMe && !first) {
      newlyLost++;
      upsert.push({ ...placeholder(old.targetId), iFollow: false, followsMe: false, lostAt: now });
    } else if (old.lostAt || old.ignored) {
      upsert.push({ ...placeholder(old.targetId), iFollow: false, followsMe: false, lostAt: old.lostAt });
    } else {
      remove.push(old.targetId);
    }
  }
  return { upsert, remove, newlyLost };
}

/** 两边都读不到的人没有新资料，写库时只更新关系字段、保留原来的名字和粉丝数 */
function placeholder(id: string): PersonInfo & { keepInfo: true } {
  return { id, handle: "", name: null, verifiedType: null, followers: 0, following: 0, keepInfo: true };
}

export const isKeepInfo = (r: NextRow): boolean => (r as NextRow & { keepInfo?: boolean }).keepInfo === true;

/** 扫一次大约要读多少人：读到的比估算的多一点也照读（关注数在扫描过程中会变），多读的按实际补扣 */
export function readLimit(estimate: number): number {
  return estimate + Math.max(20, Math.ceil(estimate * 0.02));
}

/** 名单导出成 CSV（带 BOM，Excel 打开不乱码） */
export function toCsv(rows: { handle: string; name: string | null; followers: number; following: number; verifiedType: string | null; status: string }[]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    // 防止表格软件把 = + - @ 开头的内容当公式
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["用户名", "名字", "粉丝数", "关注数", "蓝V", "状态", "主页"];
  const lines = rows.map((r) =>
    [r.handle, r.name ?? "", r.followers, r.following, r.verifiedType ? "是" : "", r.status, `https://x.com/${r.handle}`].map(esc).join(","),
  );
  return `﻿${[head.join(","), ...lines].join("\n")}\n`;
}

/** 粉丝数显示成「1.2万」 */
export function fmtCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}万`;
  return String(n);
}
