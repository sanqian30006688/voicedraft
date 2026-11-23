import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AccountMemory } from "@/lib/memory-core";
import type { StyleTraits } from "@/lib/style-card";
import type { CardSpec } from "@/lib/image-render";

/** 二进制（图片）；postgres-js 读出来是 Buffer，PGlite 是 Uint8Array，两者都能当 Uint8Array 用 */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const userRef = () =>
  uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  // 给人看的短编号（10001 起），客服找人、手动充值用
  userNo: integer("user_no")
    .notNull()
    .unique()
    .default(sql`nextval('users_user_no_seq')`),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: userRef(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const samples = pgTable(
  "samples",
  {
    id: id(),
    userId: userRef(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    lang: text("lang").notNull(), // zh | en
    source: text("source").notNull(), // paste | file | x_archive
    postedAt: timestamp("posted_at", { withTimezone: true }),
    excluded: boolean("excluded").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("samples_user_hash_idx").on(t.userId, t.contentHash)],
);

export const styleCards = pgTable(
  "style_cards",
  {
    id: id(),
    userId: userRef(),
    lang: text("lang").notNull().default("zh"),
    version: integer("version").notNull(),
    traits: jsonb("traits").$type<StyleTraits>().notNull(),
    source: text("source").notNull(), // generated | edited | learned | rollback
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("style_cards_user_lang_version_idx").on(t.userId, t.lang, t.version)],
);

export interface DraftSentence {
  text: string;
  original: string;
  locked: boolean;
}

/** 长文草稿（单条长推 / 串推 / X 长文）的附加信息；起草页的草稿为空 */
export interface DraftMeta {
  title?: string;
  notes?: string;
  length?: "short" | "medium" | "long";
  outline?: string[];
  numbered?: boolean;
  /** 选好的配图（发布时挂在第一条上） */
  imageId?: string;
}

export const drafts = pgTable(
  "drafts",
  {
    id: id(),
    userId: userRef(),
    topic: text("topic").notNull(),
    mode: text("mode").notNull(), // quick | sentence | single | thread | article（后三种是长文）
    status: text("status").notNull().default("draft"), // draft | copied
    sentences: jsonb("sentences").$type<DraftSentence[]>().notNull(),
    meta: jsonb("meta").$type<DraftMeta>(),
    finalText: text("final_text").notNull().default(""),
    styleCardVersion: integer("style_card_version"),
    // 从灵感池起草时记下来源，用于相似度提醒
    sourceItemId: uuid("source_item_id").references(() => feedItems.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("drafts_user_idx").on(t.userId, t.updatedAt)],
);

export const editLogs = pgTable(
  "edit_logs",
  {
    id: id(),
    userId: userRef(),
    draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "set null" }),
    original: text("original").notNull(),
    edited: text("edited").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("edit_logs_user_idx").on(t.userId, t.createdAt)],
);

export interface LearningSuggestion {
  observations: string[];
  traits: StyleTraits;
}

/** 从修改记录中总结出的风格更新建议，用户确认后写入风格卡 */
export const styleLearnings = pgTable(
  "style_learnings",
  {
    id: id(),
    userId: userRef(),
    editCount: integer("edit_count").notNull(),
    // 本次总结覆盖到的最后一条修改的时间；之后的修改算作「新修改」
    lastEditAt: timestamp("last_edit_at", { withTimezone: true }).notNull(),
    suggestion: jsonb("suggestion").$type<LearningSuggestion>().notNull(),
    baseVersion: integer("base_version").notNull(),
    status: text("status").notNull().default("pending"), // pending | accepted | dismissed
    createdAt: createdAt(),
  },
  (t) => [index("style_learnings_user_idx").on(t.userId, t.createdAt)],
);

export interface BlindItem {
  text: string;
  isAi: boolean;
}

export const blindTests = pgTable(
  "blind_tests",
  {
    id: id(),
    userId: userRef(),
    styleCardVersion: integer("style_card_version").notNull(),
    items: jsonb("items").$type<BlindItem[]>().notNull(),
    guesses: jsonb("guesses").$type<number[]>(), // 用户认为是 AI 写的条目下标
    misjudgeRate: integer("misjudge_rate"), // 百分比
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("blind_tests_user_idx").on(t.userId, t.createdAt)],
);

/** 推广链接：TG 群、QQ 群等，生成内容时可选带上 */
export const promoLinks = pgTable(
  "promo_links",
  {
    id: id(),
    userId: userRef(),
    kind: text("kind").notNull(), // tg | qq | discord | wechat | other
    name: text("name").notNull(),
    url: text("url").notNull(),
    blurb: text("blurb").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("promo_links_user_idx").on(t.userId, t.createdAt)],
);

/** 每位用户的推广偏好：每篇都带 / 每篇自己选 / 不带，以及默认带哪条 */
export const promoSettings = pgTable("promo_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("ask"), // always | ask | off
  defaultLinkId: uuid("default_link_id").references(() => promoLinks.id, { onDelete: "set null" }),
});

export const usersRelations = relations(users, ({ many }) => ({
  samples: many(samples),
  styleCards: many(styleCards),
}));

/** 绑定的 X 账号（OAuth 2.0 用户授权）。令牌加密保存。每个用户目前绑定一个账号。 */
export const xAccounts = pgTable(
  "x_accounts",
  {
    id: id(),
    userId: userRef(),
    xUserId: text("x_user_id").notNull(),
    handle: text("handle").notNull(),
    name: text("name"),
    scopes: text("scopes").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // 令牌失效（用户在 X 上撤销授权等）时记下原因，需要重新连接
    authError: text("auth_error"),
    // 是不是 X 会员（Basic / Premium / Premium+）：会员一条推文能写很长；null = 还没查过
    premium: boolean("premium"),
    premiumCheckedAt: timestamp("premium_checked_at", { withTimezone: true }),
    // 自动回复：拉取提及与评论
    autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(false),
    autoReplyIntervalMin: integer("auto_reply_interval_min").notNull().default(15),
    mentionsSinceId: text("mentions_since_id"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    skipKeywords: jsonb("skip_keywords").$type<string[]>().notNull().default([]),
    skipHandles: jsonb("skip_handles").$type<string[]>().notNull().default([]),
    maxRounds: integer("max_rounds").notNull().default(3),
    // 限流或账号异常时暂停拉取，到这个时间再继续
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    // 关注的人：从首页时间线（按时间排的「正在关注」）里挑帖子，写好回复候选推到 TG，用户点了才发
    timelineEnabled: boolean("timeline_enabled").notNull().default(false),
    timelineIntervalMin: integer("timeline_interval_min").notNull().default(60),
    timelineSinceId: text("timeline_since_id"),
    timelineCheckedAt: timestamp("timeline_checked_at", { withTimezone: true }),
    // 只挑含这些关键词的帖子（空 = 不限）
    timelineKeywords: jsonb("timeline_keywords").$type<string[]>().notNull().default([]),
    // 只挑这些账号的帖子（空 = 关注的所有人）
    timelineHandles: jsonb("timeline_handles").$type<string[]>().notNull().default([]),
    // 每天（最近 24 小时）最多写几条回复候选
    timelineDailyCap: integer("timeline_daily_cap").notNull().default(10),
    // 每次最多读几条帖子（按条计费）
    timelineReadLimit: integer("timeline_read_limit").notNull().default(20),
    timelinePausedUntil: timestamp("timeline_paused_until", { withTimezone: true }),
    timelinePausedReason: text("timeline_paused_reason"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // 一个用户绑一个 X 账号，一个 X 账号也只能被一个用户绑定
  (t) => [uniqueIndex("x_accounts_user_idx").on(t.userId), uniqueIndex("x_accounts_x_user_idx").on(t.xUserId)],
);

/** OAuth 授权进行中的临时状态（10 分钟有效） */
export const xOauthStates = pgTable("x_oauth_states", {
  state: text("state").primaryKey(),
  userId: userRef(),
  codeVerifier: text("code_verifier").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * 发布任务：单条或串推。立即发布和定时发布都走这里。
 * 串推逐条发出，每发出一条就把 id 记进 postIds，失败重试时从断点继续。
 */
export const posts = pgTable(
  "posts",
  {
    id: id(),
    userId: userRef(),
    draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "set null" }),
    tweets: jsonb("tweets").$type<string[]>().notNull(),
    // scheduled | paused（一键暂停，到点不发） | publishing | published | failed | canceled
    status: text("status").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    postIds: jsonb("post_ids").$type<string[]>().notNull().default([]),
    // 引用推文：第一条带上被引用推文的 id
    quoteTweetId: text("quote_tweet_id"),
    // 配图：挂在第一条上
    imageId: uuid("image_id").references(() => images.id, { onDelete: "set null" }),
    handle: text("handle"),
    // 排期时绑定的 X 账号；发布前换了账号就不发，避免发到别的账号上
    xUserId: text("x_user_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("posts_user_idx").on(t.userId, t.createdAt), index("posts_due_idx").on(t.status, t.scheduledAt)],
);

/** 自动回复队列：拉到的提及 / 评论，附带 AI 回复候选，用户确认后发出 */
export const replyItems = pgTable(
  "reply_items",
  {
    id: id(),
    userId: userRef(),
    tweetId: text("tweet_id").notNull(),
    conversationId: text("conversation_id"),
    authorId: text("author_id").notNull(),
    authorHandle: text("author_handle").notNull(),
    authorName: text("author_name"),
    text: text("text").notNull(),
    // 对方这条是回复哪条推文的（用于展示上下文）
    inReplyToText: text("in_reply_to_text"),
    // mention：@我 / 评论我的；timeline：关注的人发的帖子（对方没有 @我，只推候选，用户点了才发）
    source: text("source").notNull().default("mention"),
    // 关注的人的帖子为什么被挑中（例如「含关键词 AI」）
    matchReason: text("match_reason"),
    tweetedAt: timestamp("tweeted_at", { withTimezone: true }),
    candidates: jsonb("candidates").$type<string[]>().notNull().default([]),
    // pending | sent | skipped | failed
    status: text("status").notNull().default("pending"),
    skipReason: text("skip_reason"),
    replyText: text("reply_text"),
    replyPostId: text("reply_post_id"),
    // 已推送到 TG 机器人的时间（每条只推一次）
    tgNotifiedAt: timestamp("tg_notified_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reply_items_user_tweet_idx").on(t.userId, t.tweetId),
    index("reply_items_user_status_idx").on(t.userId, t.status, t.createdAt),
  ],
);

/**
 * 灵感：从 X 书签同步来的推文，或用户贴链接加进来的推文。
 * 只当选题和引用对象用，不进「素材」（素材只放用户本人写的推文，用来学风格）。
 */
export const inspirations = pgTable(
  "inspirations",
  {
    id: id(),
    userId: userRef(),
    source: text("source").notNull(), // x_bookmark | x_link
    tweetId: text("tweet_id").notNull(),
    authorId: text("author_id"),
    authorHandle: text("author_handle").notNull(),
    authorName: text("author_name"),
    text: text("text").notNull(),
    tweetedAt: timestamp("tweeted_at", { withTimezone: true }),
    // 引用推文的 AI 候选
    quoteCandidates: jsonb("quote_candidates").$type<string[]>().notNull().default([]),
    // new | used | dismissed
    status: text("status").notNull().default("new"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inspirations_user_tweet_idx").on(t.userId, t.tweetId),
    index("inspirations_user_status_idx").on(t.userId, t.status, t.createdAt),
  ],
);

/**
 * TG 绑定：平台统一提供一个官方 Bot，用户在应用里生成绑定码，
 * 在 TG 里打开 Bot 发送 /start 绑定码，即把这个私聊和用户关联起来。
 */
export const tgBindings = pgTable("tg_bindings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  chatId: text("chat_id").unique(),
  // 绑定码：10 分钟有效，绑定成功后清空
  bindCode: text("bind_code").unique(),
  bindCodeExpiresAt: timestamp("bind_code_expires_at", { withTimezone: true }),
  boundAt: timestamp("bound_at", { withTimezone: true }),
  // TG 的 @用户名 和显示名：后台找人用，用户每次发消息时更新
  tgUsername: text("tg_username"),
  tgName: text("tg_name"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // 机器人里的对话状态：正在等用户输入什么、最近一批候选
  botState: jsonb("bot_state").$type<BotState>().notNull().default({}),
});

/** 机器人对话状态（存在 tg_bindings.bot_state） */
export interface BotState {
  /** 正在等用户发来的内容 */
  await?:
    | { kind: "topic"; sourceId?: string; ref?: string }
    | { kind: "edit"; draftId: string }
    | { kind: "part"; draftId: string }
    | { kind: "samples" }
    | { kind: "trait"; field: string }
    | { kind: "promo" }
    | { kind: "long"; format: "single" | "thread" | "article"; length: "short" | "medium" | "long" }
    | { kind: "outline" }
    | { kind: "xlink" }
    | { kind: "channel" }
    | { kind: "autosrc" }
    | { kind: "autoedit"; autoId: string }
    | { kind: "autoset"; field: "cap" | "gap" | "per" | "hours" }
    | { kind: "quote"; inspId: string }
    | { kind: "schedule"; draftId: string }
    | { kind: "reply"; replyId: string }
    | { kind: "follow_keywords" }
    | { kind: "follow_handles" }
    | { kind: "memory"; field: string }
    | { kind: "choose"; text: string }
    | { kind: "topup_amount" }
    | { kind: "txid"; topupId: string }
    | { kind: "team_submit" }
    | { kind: "team_edit"; subId: string }
    | { kind: "team_reject"; subId: string }
    | { kind: "team_name" }
    | { kind: "image"; draftId: string }
    | { kind: "image_ref"; draftId?: string; fileId: string; mime: string; caption?: string }
    | { kind: "announce_edit"; annId: string }
    | { kind: "announce_new" }
    | { kind: "mutual_search" };
  /** 互关检测名单的搜索词 */
  mutualQ?: string;
  /** 互关检测：在哪个名单里点的搜索（名单:只看蓝V） */
  mutualTab?: string;
  /** 已经看过「怎么用」小提示的主菜单按钮（每个按钮第一次点时给一句） */
  tips?: string[];
  /** 最近一批起草候选，按钮里带 token，防止点到过期的候选 */
  batch?: { token: string; topic: string; sourceId?: string; ref?: string; candidates: string[]; promo?: boolean };
  /** 长文进行中：格式、篇幅、主题、提纲，以及单条长推候选 / 换段候选 */
  long?: {
    token: string;
    format: "single" | "thread" | "article";
    length: "short" | "medium" | "long";
    topic: string;
    title: string;
    outline: string[];
    candidates?: string[];
    rewrite?: { draftId: string; position: number; candidates: string[] };
  };
  /** 准备发出的引用推文 */
  quote?: { inspId: string; tweetId: string; handle: string; text: string };
  /** 自动发帖：用户刚发来、还没选「订阅 / 只用这一篇」的网址 */
  pendingSrc?: string;
  /** 进行中的盲测：已勾选为「AI 写的」条目 */
  blind?: { id: string; picks: number[] };
}

/**
 * 信息源：
 * - tg_channel：公开 TG 频道（读取 t.me/s/频道名 公开预览页），handle 是频道用户名
 * - tg_group：拉了平台机器人进去的 TG 群，handle 是群的 chat id
 * - x_user：X 用户主页（官方 API 读时间线），handle 是用户名，xUserId 记在 url
 * - rss：RSS / Atom 订阅，handle 是订阅地址
 * - web：网页 / 论坛列表页，定时看有没有新文章链接，handle 是网址
 * - link：单个链接，只读一次
 */
export const sources = pgTable(
  "sources",
  {
    id: id(),
    userId: userRef(),
    type: text("type").notNull(),
    handle: text("handle").notNull(),
    title: text("title"),
    // 网页源：用户填的原始地址（rss 时是发现订阅地址前的网页）；x_user：X 的用户 id
    url: text("url"),
    enabled: boolean("enabled").notNull().default(true),
    // 已收进来的最新一条消息编号，下次只收更新的
    cursor: integer("cursor"),
    // X 主页：已读到的最新推文 id
    sinceId: text("since_id"),
    // 网页 / RSS：已经见过的文章链接（最近 300 条），用来去重
    seen: jsonb("seen").$type<string[]>().notNull().default([]),
    // 多久检查一次（分钟）
    intervalMin: integer("interval_min").notNull().default(30),
    // 这个源的新内容要不要拿去自动发帖
    autopilot: boolean("autopilot").notNull().default(true),
    // 只有这个时间之后收进来的内容才会自动发（订阅时已有的旧内容不发）
    autoSince: timestamp("auto_since", { withTimezone: true }),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sources_user_type_handle_idx").on(t.userId, t.type, t.handle)],
);

/**
 * 灵感池条目：从外部收进来的内容，只作为选题素材，不进入风格样本。
 * points 是 AI 提炼的要点，用户点一个要点即可带进起草页。
 */
export const feedItems = pgTable(
  "feed_items",
  {
    id: id(),
    userId: userRef(),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // tg_forward | tg_channel | tg_group | x_user | web | manual
    text: text("text").notNull(),
    contentHash: text("content_hash").notNull(),
    url: text("url"),
    // 来源名称：频道名；转发自个人时不记名字
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    points: jsonb("points").$type<string[]>(),
    status: text("status").notNull().default("new"), // new | saved | dismissed | used
    // 别的信息源也发了同一件事（跨来源去重时没收进来的那些）：记下来源，用来判断热点
    alsoSeen: jsonb("also_seen").$type<{ sourceId: string | null; author: string | null }[]>().notNull().default([]),
    // 热点提醒：这条所在的话题推过提醒的时间（同一话题只推一次）；hotSources 只记在推出去的那一条上
    hotAt: timestamp("hot_at", { withTimezone: true }),
    hotSources: integer("hot_sources"),
    // 原帖里的图片地址（X、TG 频道的公开图片），自动发帖配图时先看能不能用
    media: jsonb("media").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("feed_items_user_hash_idx").on(t.userId, t.contentHash),
    index("feed_items_user_created_idx").on(t.userId, t.createdAt),
  ],
);

// ---------- 计费：按次从 USDT 余额扣 ----------

/** 金额一律用「微 USDT」整数（1 USDT = 1_000_000），不用小数，避免误差 */
const micro = (name: string) => bigint(name, { mode: "number" });

/** 每位用户的余额 */
export const wallets = pgTable("wallets", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  balanceMicro: micro("balance_micro").notNull().default(0),
  // 余额里有多少是签到 / 邀请送的「赠送额度」：扣费时先扣它；到期没用完的从余额里扣掉（见 lib/rewards.ts）
  bonusMicro: micro("bonus_micro").notNull().default(0),
  // 赠送额度到期时间：每次拿到新奖励都往后顺延
  bonusExpiresAt: timestamp("bonus_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 余额流水：充值、扣费、管理员调整，每笔都记下变动后的余额 */
export const ledger = pgTable(
  "ledger",
  {
    id: id(),
    userId: userRef(),
    kind: text("kind").notNull(), // topup | charge | adjust | bonus
    // 扣费项目（价目表的 key），充值时为空
    item: text("item"),
    quantity: integer("quantity").notNull().default(1),
    amountMicro: micro("amount_micro").notNull(), // 充值为正，扣费为负
    balanceAfterMicro: micro("balance_after_micro").notNull(),
    note: text("note"),
    refId: text("ref_id"),
    // 团队钱包：实际是哪位成员用掉的（扣的是所有者的余额）；自己用自己的余额时为空
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("ledger_user_idx").on(t.userId, t.createdAt), index("ledger_actor_idx").on(t.actorUserId, t.createdAt)],
);

/**
 * USDT 充值单：和 Q站 一样不经第三方，用户转账到我们自己的收款地址。
 * 每张单的应付金额带一个唯一的小数尾数（+0.01～0.99），扫链看到这笔金额到账就入账。
 */
export const topups = pgTable(
  "topups",
  {
    id: id(),
    userId: userRef(),
    chain: text("chain").notNull(),
    address: text("address").notNull(),
    baseMicro: micro("base_micro").notNull(),
    dueMicro: micro("due_micro").notNull(),
    // pending | paid | expired | canceled
    status: text("status").notNull().default("pending"),
    txid: text("txid").unique(),
    receivedMicro: micro("received_micro"),
    fromAddress: text("from_address"),
    // 过了 expiresAt 不再显示给用户；到 holdUntil 之前这个金额仍为这张单保留，晚到的转账也能认
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    holdUntil: timestamp("hold_until", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // 发起充值的 TG 私聊，到账后在那里通知
    tgChatId: text("tg_chat_id"),
    // TG 里那张充值卡片的消息，用来更新倒计时、到账 / 过期状态
    tgMessageId: integer("tg_message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("topups_user_idx").on(t.userId, t.createdAt),
    index("topups_open_idx").on(t.chain, t.status, t.dueMicro),
  ],
);

/** 链上看到的、转到收款地址但没对上充值单的转账，管理员在后台处理 */
export const chainDeposits = pgTable(
  "chain_deposits",
  {
    id: id(),
    chain: text("chain").notNull(),
    txid: text("txid").notNull(),
    logIndex: integer("log_index").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    amountMicro: micro("amount_micro").notNull(),
    blockNumber: integer("block_number").notNull(),
    // matched | unmatched | resolved
    status: text("status").notNull(),
    topupId: uuid("topup_id").references(() => topups.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("chain_deposits_tx_idx").on(t.chain, t.txid, t.logIndex)],
);

/** 简单的键值设置：价目表、收款地址、扫链进度等 */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- 自动发帖：信息源 → 按文风改写 → 官方 API 发出 ----------

/** 每位用户的自动发帖设置 */
export const autopilotSettings = pgTable("autopilot_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  // auto：写好直接排进定时发出；review：先推到 TG / 网页，点确认才发
  mode: text("mode").notNull().default("review"),
  // 过去 24 小时最多发几条（含待确认的）
  dailyCap: integer("daily_cap").notNull().default(5),
  // 两条之间隔多少分钟：在 minGapMin 和 maxGapMin 之间随机（maxGapMin 不大于 minGapMin 时就是固定间隔）
  minGapMin: integer("min_gap_min").notNull().default(90),
  maxGapMin: integer("max_gap_min").notNull().default(0),
  // 只在这段时间内发（本地时间，按 tz）；默认 0–24 全天
  startHour: integer("start_hour").notNull().default(0),
  endHour: integer("end_hour").notNull().default(24),
  tz: text("tz").notNull().default("Asia/Shanghai"),
  // 附上原文链接（带链接的帖子按「发带链接的帖子」计费）
  attachLink: boolean("attach_link").notNull().default(false),
  // 按推广设置带上推广链接
  withPromo: boolean("with_promo").notNull().default(false),
  // 自动配一张信息卡（把帖子要点排成图，不收费）
  withImage: boolean("with_image").notNull().default(false),
  // 原文里有链接（教程、文章）时：正文不放链接，发出后用自己的号在评论区回复一条带链接的
  linkReply: boolean("link_reply").notNull().default(false),
  // 长原文写长：X 会员写一条长推，不是会员写成串推（关掉就最多写满一条）
  longForm: boolean("long_form").notNull().default(true),
  // 只用多少小时内发布的内容（按原文发布时间；不知道发布时间的按收进来的时间）
  maxAgeHours: integer("max_age_hours").notNull().default(48),
  // 同一个信息源过去 24 小时最多用几条，免得一个大 V 刷屏
  perSourceDaily: integer("per_source_daily").notNull().default(2),
  // 给 AI 的额外要求，例如「多点评、少复述，结尾提一个问题」
  instruction: text("instruction").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 自动写出来的每一条：待确认 / 已排期 / 已发出 / 跳过 */
export const autoPosts = pgTable(
  "auto_posts",
  {
    id: id(),
    userId: userRef(),
    feedItemId: uuid("feed_item_id").references(() => feedItems.id, { onDelete: "set null" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    text: text("text").notNull().default(""),
    // 和原文的重合度（百分比）
    similarity: integer("similarity"),
    // 质量分（0–100，代码打分，不调 AI）
    quality: integer("quality"),
    // review：等确认；scheduled：已排进定时；published；skipped；failed
    status: text("status").notNull(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "set null" }),
    // 自动配的图
    imageId: uuid("image_id").references(() => images.id, { onDelete: "set null" }),
    // 发出后在评论区回复的链接（开了 linkReply 并且原文有链接时）
    replyLink: text("reply_link"),
    note: text("note"),
    tgNotifiedAt: timestamp("tg_notified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auto_posts_user_item_idx").on(t.userId, t.feedItemId),
    index("auto_posts_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * 账号记忆：这个账号过去发过什么、经常聊什么、坚持和反对哪些观点、喜欢怎么说。
 * 由 AI 从本人的推文（素材 + 已发出的帖子）里总结，用户可以改；每次生成都会带上，保证人设前后一致。
 */
export const accountMemories = pgTable("account_memories", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  memory: jsonb("memory").$type<AccountMemory>().notNull(),
  // auto：AI 总结；edited：用户改过（之后自动更新只增补，不删用户写的）
  source: text("source").notNull().default("auto"),
  enabled: boolean("enabled").notNull().default(true),
  // 上次整理时用了多少条本人推文；新增够一定条数自动再整理
  postsAtBuild: integer("posts_at_build").notNull().default(0),
  builtAt: timestamp("built_at", { withTimezone: true }),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- 团队：共用一个钱包，成员投稿给官号，所有者 / 管理员审批 ----------

/**
 * 团队。团队钱包就是所有者自己的余额（所有者照常充值），成员在各自上限内从里面扣。
 * officialUserId：官号是谁连接的 X 账号（只能由所有者或管理员把自己连接的 X 设为官号）。
 */
export const teams = pgTable("teams", {
  id: id(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  officialUserId: uuid("official_user_id").references(() => users.id, { onDelete: "set null" }),
  // 成员用完团队给的额度后：true 改扣成员自己的余额，false 直接停
  fallbackPersonal: boolean("fallback_personal").notNull().default(true),
  // 新成员默认的每天 / 每月上限（微 USDT，空 = 不限）
  defaultDailyMicro: micro("default_daily_micro"),
  defaultMonthlyMicro: micro("default_monthly_micro"),
  createdAt: createdAt(),
});

/** 团队成员（含所有者）。一个人同时只能在一个团队里 */
export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: userRef(),
    role: text("role").notNull(), // owner | admin | member
    // 每天 / 每月最多从团队钱包用多少（微 USDT，空 = 不限）；所有者不受限
    dailyMicro: micro("daily_micro"),
    monthlyMicro: micro("monthly_micro"),
    joinedAt: createdAt(),
  },
  (t) => [uniqueIndex("team_members_user_idx").on(t.userId), index("team_members_team_idx").on(t.teamId)],
);

/** 邀请链接：7 天有效，可以多人用，所有者 / 管理员随时作废 */
export const teamInvites = pgTable(
  "team_invites",
  {
    code: text("code").primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    uses: integer("uses").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("team_invites_team_idx").on(t.teamId)],
);

/** 给官号的投稿：成员提交，所有者 / 管理员通过（立即发或定时）、修改或驳回 */
export const teamSubmissions = pgTable(
  "team_submissions",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    authorUserId: userRef(),
    tweets: jsonb("tweets").$type<string[]>().notNull(),
    note: text("note"),
    // pending | approved | rejected | withdrawn
    status: text("status").notNull().default("pending"),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    rejectReason: text("reject_reason"),
    // 通过后生成的发布任务（属于官号持有人）
    postId: uuid("post_id").references(() => posts.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("team_submissions_team_idx").on(t.teamId, t.status, t.createdAt), index("team_submissions_author_idx").on(t.authorUserId, t.createdAt)],
);

// ---------- 签到、邀请奖励 ----------

/**
 * 每日签到（按北京时间算一天）。没充过值的人签到奖励先存着（held），第一次充值到账后一起发（released_at）。
 */
export const checkins = pgTable(
  "checkins",
  {
    id: id(),
    userId: userRef(),
    /** 北京时间的日期 YYYY-MM-DD */
    day: text("day").notNull(),
    /** 连续第几天 */
    streak: integer("streak").notNull(),
    amountMicro: micro("amount_micro").notNull(),
    held: boolean("held").notNull().default(false),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("checkins_user_day_idx").on(t.userId, t.day)],
);

/** 每人一个邀请码：t.me/机器人?start=ref_邀请码 */
export const referralCodes = pgTable("referral_codes", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(),
  createdAt: createdAt(),
});

/**
 * 谁邀请了谁。被邀请的人第一次充值到账后才发奖励：
 * pending 等首充 → rewarded 已发 / review 等管理员审核（疑似自己邀自己、超过每月上限）/ rejected 不发
 */
export const referrals = pgTable(
  "referrals",
  {
    inviteeUserId: uuid("invitee_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    inviterUserId: uuid("inviter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    via: text("via").notNull(), // tg | web
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    topupMicro: micro("topup_micro"),
    fromAddress: text("from_address"),
    inviterRewardMicro: micro("inviter_reward_micro"),
    inviteeRewardMicro: micro("invitee_reward_micro"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("referrals_inviter_idx").on(t.inviterUserId, t.status)],
);

// ---------- 推主数据：每日快照、行业对比、自愿排行榜 ----------

/**
 * 每天（北京时间）一次，用官方接口读本人账号的公开数据（粉丝、关注、发帖总数等）。
 * 只记已连接的客户自己的账号，不读别人的。x_user_id 用来区分换绑前后的账号，涨粉只在同一账号内算。
 */
export const xStatSnapshots = pgTable(
  "x_stat_snapshots",
  {
    id: id(),
    userId: userRef(),
    xUserId: text("x_user_id").notNull(),
    /** 北京时间的日期 YYYY-MM-DD */
    day: text("day").notNull(),
    followers: integer("followers").notNull(),
    following: integer("following").notNull(),
    tweets: integer("tweets").notNull(),
    listed: integer("listed").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("x_stat_snapshots_user_day_idx").on(t.userId, t.day)],
);

/**
 * 推主数据的个人设置：行业（自动判断或本人选）、是否公开上榜（默认不公开）、是否收周报。
 */
export const benchmarkProfiles = pgTable("benchmark_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  industry: text("industry"),
  // auto：按账号记忆 / 风格卡自动判断；user：本人选的（之后不再自动改）
  industrySource: text("industry_source").notNull().default("auto"),
  // 公开上榜：本人点了才开，会显示 @用户名
  publicRank: boolean("public_rank").notNull().default(false),
  publicSince: timestamp("public_since", { withTimezone: true }),
  weeklyReport: boolean("weekly_report").notNull().default(true),
  lastReportAt: timestamp("last_report_at", { withTimezone: true }),
  // 今天已经尝试读过数据（失败也记，免得每 30 秒重试）
  snapshotTriedDay: text("snapshot_tried_day"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- 日报：每天早上给顾客发昨日小结，给平台方发经营日报 ----------

/**
 * 接口用量：AI（按 token）和 X（按发出 / 读到的条数），按小时累加。
 * 只用来算平台方的成本，不按人记；单价在后台「日报」里改，算成本时再乘。
 */
export const apiUsage = pgTable(
  "api_usage",
  {
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    // ai | x
    provider: text("provider").notNull(),
    // ai：input / output / cache_write / cache_read（token 数）；x：post（发出）/ read（读到的推文、用户）
    kind: text("kind").notNull(),
    units: bigint("units", { mode: "number" }).notNull().default(0),
    calls: integer("calls").notNull().default(0),
  },
  (t) => [uniqueIndex("api_usage_hour_idx").on(t.hour, t.provider, t.kind)],
);

/** 顾客的日报设置；没有这一行 = 默认开，早上 9 点，北京时间 */
export const dailyReportSettings = pgTable("daily_report_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  hour: integer("hour").notNull().default(9),
  tz: text("tz").notNull().default("Asia/Shanghai"),
  // 最近一次发的是哪天的日报（按顾客的时区，YYYY-MM-DD），每天只发一次
  lastSentDay: text("last_sent_day"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 发帖效果：帖子发出后 1 天、7 天各读一次 X 上的数据（浏览、点赞、转发、回复、引用、收藏）。
 * 串推只读第一条。平台承担读取费用，不向顾客收费。
 */
export interface TweetMetrics {
  impressions: number;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
}

export const postMetrics = pgTable(
  "post_metrics",
  {
    id: id(),
    userId: userRef(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tweetId: text("tweet_id").notNull(),
    // short | long | thread | link | quote | auto（自动发帖）
    kind: text("kind").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    // null + 读取时间有值 = X 上已经找不到这条（删了）
    d1: jsonb("d1").$type<TweetMetrics | null>(),
    d1At: timestamp("d1_at", { withTimezone: true }),
    d7: jsonb("d7").$type<TweetMetrics | null>(),
    d7At: timestamp("d7_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("post_metrics_post_idx").on(t.postId), index("post_metrics_user_idx").on(t.userId, t.publishedAt)],
);

/** 热点提醒设置；没有这一行 = 默认开，3 个信息源以上算热点，每天最多 3 条 */
export const hotTopicSettings = pgTable("hot_topic_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  minSources: integer("min_sources").notNull().default(3),
  dailyCap: integer("daily_cap").notNull().default(3),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 配图：信息卡 / 封面（程序排版，字不会错）、AI 画的无字配图、用户自己发来的图。
 * 图片存在数据库里，按人隔离；没被草稿或待发帖子用到的，30 天后清理。
 */
export const images = pgTable(
  "images",
  {
    id: id(),
    userId: userRef(),
    draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "set null" }),
    // card（信息卡 / 封面）| ai（AI 画的配图）| upload（用户自己的图）| source（原帖的原图）
    kind: text("kind").notNull(),
    // 排版参数；换风格、改标题字时按它重新排，不用再调 AI
    spec: jsonb("spec").$type<CardSpec>(),
    mime: text("mime").notNull(),
    data: bytea("data").notNull(),
    // AI 画的无字背景（原图），用来重新叠标题
    bg: bytea("bg"),
    bgMime: text("bg_mime"),
    createdAt: createdAt(),
  },
  (t) => [index("images_user_idx").on(t.userId, t.createdAt)],
);

/**
 * 功能更新公告：通过机器人群发给所有绑定了 TG 的用户。
 * source=auto：代码里的更新记录（src/lib/changelog.ts）上线后自动起草；manual：管理员在后台或机器人里手写。
 * status：draft 草稿（等管理员点发送）| sending 发送中（按用户当地白天分批发）| sent 发完 | cancelled 不发了
 */
export const announcements = pgTable("announcements", {
  id: id(),
  source: text("source").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("draft"),
  // 自动起草时合并进来的更新记录 id
  entryIds: jsonb("entry_ids").$type<string[]>().notNull().default([]),
  // 紧急：不等用户当地白天，马上发
  urgent: boolean("urgent").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  // 发给管理员审核的那几张卡片，内容变了时把旧卡片标成「已更新」
  reviewCards: jsonb("review_cards").$type<{ chatId: string; mid: number }[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  sendStartedAt: timestamp("send_started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** 公告发给了谁：status sent | failed | blocked（用户停用了机器人）。断了重启也能接着发，不会重复 */
export const announcementDeliveries = pgTable(
  "announcement_deliveries",
  {
    announcementId: uuid("announcement_id")
      .notNull()
      .references(() => announcements.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    error: text("error"),
    at: createdAt(),
  },
  (t) => [uniqueIndex("announcement_deliveries_uniq").on(t.announcementId, t.userId)],
);

/**
 * 互关检测：每位用户上一次扫描的结果（关注 / 粉丝里的每个人一行）。
 * ownXUserId 记的是扫描时绑定的 X 账号，换了 X 账号就只看新账号的。
 * lostAt：上一次扫描还是粉丝、这一次不是了（取关了我）；重新关注回来时清掉。
 */
export const followPeople = pgTable(
  "follow_people",
  {
    userId: userRef(),
    ownXUserId: text("own_x_user_id").notNull(),
    targetId: text("target_id").notNull(),
    handle: text("handle").notNull(),
    name: text("name"),
    // X 的认证类型：blue | business | government；没认证为 null
    verifiedType: text("verified_type"),
    followers: integer("followers").notNull().default(0),
    following: integer("following").notNull().default(0),
    iFollow: boolean("i_follow").notNull().default(false),
    followsMe: boolean("follows_me").notNull().default(false),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    ignored: boolean("ignored").notNull().default(false),
    unfollowedAt: timestamp("unfollowed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("follow_people_uniq").on(t.userId, t.ownXUserId, t.targetId)],
);

/** 互关检测的扫描记录：每位用户一行，记上次扫描时间、人数，和扫描前读到的估算（确认扫描时用） */
export const followScans = pgTable("follow_scans", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  ownXUserId: text("own_x_user_id"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  followingCount: integer("following_count").notNull().default(0),
  followersCount: integer("followers_count").notNull().default(0),
  estFollowing: integer("est_following"),
  estFollowers: integer("est_followers"),
  estAt: timestamp("est_at", { withTimezone: true }),
});
