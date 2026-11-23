import type { AccountMemory } from "./memory-core";

/** 风格卡：定性描述（LLM 生成 / 用户编辑）。统计指标见 metrics.ts，由代码计算。 */
export interface StyleTraits {
  catchphrases: string[]; // 常用词 / 口头禅
  bannedWords: string[]; // 从不使用的词
  openings: string; // 开头方式
  stance: string; // 观点表达
  humor: string; // 幽默类型
  topics: string[]; // 话题领域
  notes: string; // 其他补充
}

export interface StyleCard {
  version: number;
  traits: StyleTraits;
  samples: string[]; // 用户本人的推文样本
  pinned: number[]; // 钉住的样本下标，生成时总是带上
  related?: string[]; // 与本次主题最相近的原句（每次请求不同，放在用户消息里）
  memory?: AccountMemory | null; // 账号记忆（见 memory.ts）
  recent?: string[]; // 本人最近发过的几条
}

export interface EditPair {
  original: string;
  edited: string;
  at: number;
}
