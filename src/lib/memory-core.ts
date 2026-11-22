/**
 * 账号记忆：纯函数部分（类型、拼进提示词的文字、整理时机）。数据库和 AI 调用在 memory.ts。
 */

export interface AccountMemory {
  /** 一两句话：这个账号是谁、一贯在说什么 */
  persona: string;
  /** 经常讨论的话题 */
  topics: string[];
  /** 一贯坚持的观点 */
  positions: string[];
  /** 明确反对的观点 */
  opposes: string[];
  /** 喜欢的表达方式（句式、比喻、口吻） */
  phrasing: string[];
  /** 不碰的话题和说法 */
  avoid: string[];
}

export const EMPTY_MEMORY: AccountMemory = { persona: "", topics: [], positions: [], opposes: [], phrasing: [], avoid: [] };

export const MEMORY_FIELDS: { key: Exclude<keyof AccountMemory, "persona">; label: string; max: number }[] = [
  { key: "topics", label: "经常讨论", max: 12 },
  { key: "positions", label: "一贯的观点", max: 12 },
  { key: "opposes", label: "反对的观点", max: 10 },
  { key: "phrasing", label: "喜欢的表达方式", max: 10 },
  { key: "avoid", label: "不碰的话题和说法", max: 10 },
];

/** 本人推文新增这么多条后，自动再整理一次记忆 */
export const MEMORY_REFRESH_EVERY = 10;
/** 整理记忆时最多读多少条本人推文 */
export const MEMORY_READ_LIMIT = 150;
/** 生成时带上最近发过的几条 */
export const RECENT_LIMIT = 12;

const clip = (s: string, n: number) => s.trim().slice(0, n);

/** 清理用户或模型给的记忆：去空、去重、截长度和条数 */
export function cleanMemory(m: Partial<AccountMemory> | null | undefined): AccountMemory {
  const out: AccountMemory = { ...EMPTY_MEMORY, persona: clip(m?.persona ?? "", 300) };
  for (const f of MEMORY_FIELDS) {
    const list = Array.isArray(m?.[f.key]) ? (m![f.key] as unknown[]) : [];
    out[f.key] = [...new Set(list.filter((x): x is string => typeof x === "string").map((x) => clip(x, 120)).filter(Boolean))].slice(
      0,
      f.max,
    );
  }
  return out;
}

export function isEmptyMemory(m: AccountMemory): boolean {
  return !m.persona && MEMORY_FIELDS.every((f) => m[f.key].length === 0);
}

/** 要不要自动再整理：还没有记忆，或者本人推文比上次多了 MEMORY_REFRESH_EVERY 条 */
export function needsRefresh(postsNow: number, row: { postsAtBuild: number; builtAt: Date | null } | null): boolean {
  if (postsNow === 0) return false;
  if (!row || !row.builtAt) return true;
  return postsNow - row.postsAtBuild >= MEMORY_REFRESH_EVERY;
}

/** 拼进系统提示的「账号记忆」和「最近发过的」 */
export function memoryPromptBlock(memory: AccountMemory | null | undefined, recent: string[] | undefined): string {
  const parts: string[] = [];
  if (memory && !isEmptyMemory(memory)) {
    const line = (label: string, xs: string[]) => (xs.length ? `- ${label}：${xs.join("；")}` : "");
    parts.push(
      [
        "# 账号记忆（这个账号一贯的样子，每次都要前后一致）",
        memory.persona ? `- 账号定位：${memory.persona}` : "",
        line("经常讨论", memory.topics),
        line("一贯的观点", memory.positions),
        line("反对的观点（不要写出支持这些的内容）", memory.opposes),
        line("喜欢的表达方式", memory.phrasing),
        line("不碰的话题和说法", memory.avoid),
        "",
        "要求：观点立场和上面保持一致，不要今天一个立场、明天另一个；写的话题离账号定位太远时，从这个账号自己的角度切入。没提到的事不要硬编成这个账号的观点。",
      ]
        .filter((x) => x !== "")
        .join("\n"),
    );
  }
  if (recent?.length) {
    parts.push(
      `## 最近发过的（可以承接，但不要重复同样的观点、例子和说法）\n${recent.map((s) => `- ${s.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}`,
    );
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}
