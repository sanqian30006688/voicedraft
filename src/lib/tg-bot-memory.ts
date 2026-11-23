import "server-only";
import { cleanMemory, EMPTY_MEMORY, isEmptyMemory, MEMORY_FIELDS, type AccountMemory } from "./memory-core";
import { getMemoryRow, ownPostCount, refreshMemory, saveMemory } from "./memory";
import { editMessage, sendMessage, type Keyboard } from "./tg-api";
import { clearAwait, clip, errButtons, errText, getState, setState } from "./tg-bot-core";

/** 机器人里的「账号记忆」：看、重新整理、开关、补一条 */

type Field = keyof AccountMemory;
const LABEL: Record<Field, string> = {
  persona: "账号定位",
  ...Object.fromEntries(MEMORY_FIELDS.map((f) => [f.key, f.label])),
} as Record<Field, string>;

function memoryText(m: AccountMemory, enabled: boolean, posts: number, builtAt: Date | null) {
  if (isEmptyMemory(m)) {
    return `🧠 账号记忆\n\n还没整理过。记忆会记住你经常聊什么、坚持和反对什么观点、喜欢怎么说，每次写都会带上，人设前后一致。\n\n你现在有 ${posts} 条推文可以读（至少 5 条）。点「现在整理」，不收费。`;
  }
  const block = (label: string, xs: string[]) => (xs.length ? `\n\n${label}：\n${xs.map((x) => `• ${x}`).join("\n")}` : "");
  return (
    `🧠 账号记忆${enabled ? "" : "（已关闭，生成时不带）"}\n\n` +
    (m.persona ? `定位：${m.persona}` : "") +
    MEMORY_FIELDS.map((f) => block(f.label, m[f.key])).join("") +
    `\n\n${builtAt && builtAt.getTime() > 0 ? `上次整理：读了 ${posts} 条推文。` : ""}每多 10 条会自动重新整理，不收费。想改得更细可以在网页「记忆」页改。`
  );
}

function memoryButtons(enabled: boolean, empty: boolean): Keyboard {
  return [
    [
      { text: empty ? "🔄 现在整理" : "🔄 重新整理", callback_data: "mmr" },
      { text: enabled ? "⏸ 关闭" : "▶️ 开启", callback_data: `mmt:${enabled ? 0 : 1}` },
    ],
    [
      { text: "➕ 补一条观点", callback_data: "mma:positions" },
      { text: "➕ 补一条反对", callback_data: "mma:opposes" },
    ],
    [
      { text: "➕ 补一条不碰的", callback_data: "mma:avoid" },
      { text: "✏️ 改定位", callback_data: "mma:persona" },
    ],
  ];
}

export async function showMemory(userId: string, chatId: string, editId?: number) {
  const [row, posts] = await Promise.all([getMemoryRow(userId), ownPostCount(userId)]);
  const m = row ? cleanMemory(row.memory) : EMPTY_MEMORY;
  const enabled = row?.enabled ?? true;
  const text = clip(memoryText(m, enabled, posts, row?.builtAt ?? null), 3800);
  const buttons = memoryButtons(enabled, isEmptyMemory(m));
  if (editId) await editMessage(chatId, editId, text, buttons);
  else await sendMessage(chatId, text, { buttons });
}

/** 正在等用户补一条；返回 true 表示已处理 */
export async function handleMemoryAwait(userId: string, chatId: string, text: string): Promise<boolean> {
  const { await: waiting } = await getState(userId);
  if (waiting?.kind !== "memory") return false;
  await clearAwait(userId);
  const row = await getMemoryRow(userId);
  const m = row ? cleanMemory(row.memory) : EMPTY_MEMORY;
  const field = waiting.field as Field;
  const value = text.trim();
  const next: AccountMemory = field === "persona" ? { ...m, persona: value } : { ...m, [field]: [...m[field as Exclude<Field, "persona">], value] };
  await saveMemory(userId, { memory: next });
  await sendMessage(chatId, `记下了（${LABEL[field]}）：${clip(value, 100)}`);
  await showMemory(userId, chatId);
  return true;
}

/** 按钮；返回 null 表示不是这里的按钮 */
export async function handleMemoryCallback(userId: string, chatId: string, action: string, a: string, mid: number): Promise<string | undefined | null> {
  switch (action) {
    case "mm":
      await showMemory(userId, chatId);
      return;
    case "mmr": {
      const wait = await sendMessage(chatId, "正在整理账号记忆…");
      try {
        await refreshMemory(userId);
        await editMessage(chatId, wait.message_id, "整理好了 ✓");
        await showMemory(userId, chatId);
      } catch (e) {
        await editMessage(chatId, wait.message_id, errText(e), errButtons(e));
      }
      return;
    }
    case "mmt":
      await saveMemory(userId, { enabled: a === "1" });
      await showMemory(userId, chatId, mid);
      return a === "1" ? "已开启" : "已关闭";
    case "mma": {
      if (!(a in LABEL)) return "这个按钮已经失效了";
      await setState(userId, { await: { kind: "memory", field: a } });
      const eg: Record<string, string> = {
        persona: "例如：讲 AI 产品实操的独立开发者，说话直接，不追热点",
        positions: "例如：认为小团队应该先卖再做",
        opposes: "例如：反对为了融资讲故事",
        avoid: "例如：不聊政治和币价",
      };
      await sendMessage(chatId, `发一句「${LABEL[a as Field]}」给我。${eg[a] ? `\n${eg[a]}` : ""}\n发 /cancel 取消。`);
      return;
    }
  }
  return null;
}
