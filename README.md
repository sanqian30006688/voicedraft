# VoiceDraft（推特助手）

学会你本人的写作风格，帮你在 X（推特）上起草、发布、回复的开源 Web 应用，大部分操作也可以在 Telegram 机器人里点按钮完成。

**免费的开源自托管版**（[MIT 许可证](LICENSE)）：自己部署、自己填各家 API 密钥，所有功能免费使用，没有按次计费，没有充值。数据都在你自己的机器或数据库里。

- 只用 X 官方 API，不抓取 X；发布前由你确认，不做私信、关注、点赞、转推。
- 技术栈：Next.js、Drizzle、Postgres（本地用 PGlite，不用装数据库）、Claude API。
- 第一次使用：先看下面的「本地运行」，不填任何密钥也能进演示模式看界面。

文档：[产品说明 v0.2](docs/VoiceDraft_PRD_v0.2.md) · [安全说明](SECURITY.md) · [参与贡献](CONTRIBUTING.md)

## 已有功能

- 邮箱 + 密码注册登录；删除账号时清除全部数据
- 素材导入：X 官方存档（tweets.js）、.txt / .md / .csv、直接粘贴；自动去掉链接、转推、重复和少于 10 字的内容
- 素材管理：删除、标记「不代表我」、设为代表句
- AI 生成风格卡，可手动编辑；每次修改保存为新版本，可恢复任意历史版本
- 快速模式：输入主题 → 3 条整条候选 → 选一条 → 对任意一句「换这句」、直接改字、锁定、删除
- 逐句模式：开头句候选 → 逐句选择「下一句」→ 回退最后一句
- 风格卡统计指标（句长、标点、emoji 等）由代码从素材自动计算
- 修改反馈即时生效：你改过的句子会被记住，最近 10 次修改作为示例带进下一次生成
- 长文，三种形式：单条长推（一条写约 100 / 200 / 300 字，直接出 3 条候选，超过 280 加权字数会提示需要 X Premium）；串推（线程，每条按 280 检查，可加 1/n 编号、逐条复制）；X 长文（标题 + 小标题 + 建议配图位置）。串推和 X 长文先出提纲可改，再按提纲写全文；任意一条 / 一段可「换这段」并附修改要求
- 越用越像：累计 20 次新修改后提醒，AI 总结修改规律并给出风格卡更新建议，确认后保存为新版本
- 按主题挑例句：每次生成时，从素材里挑出和主题最接近的几条原句一起参考
- 草稿箱：起草页和长文页（单条长推、串推、X 长文）生成内容后自动保存，可以继续编辑、复制、发布、删除
- 风格盲测：5 条真推文和 5 条 AI 推文混在一起让你挑，记录每版风格卡的误判率
- 按 X 官方规则计算加权字数（twitter-text，中文计 2，上限 280），一键复制成品
- 连接 X 账号（OAuth 2.0 用户授权，令牌加密保存在本机）
- 一键发布：起草页的单条、长文页的串推，确认后通过 X 官方 API 发出；串推中途失败时记下断点，重试从失败那条继续
- 定时发布：选时间 → 确认 → 进入队列，可改时间、取消、立即发；遇到 X 限流自动顺延
- 发布记录：查看、在 X 上打开、从 X 删除
- 灵感（TG 素材来源）：平台统一提供一个 TG 机器人，用户在「灵感」页点「绑定 TG」，扫码或点链接后在 TG 里按「开始」即绑定，不用登录个人 TG 账号；之后把消息转发给机器人就收进灵感池。也可以订阅公开频道（读取 t.me/s/频道名 公开预览页，每 30 分钟检查一次）或手动粘贴。灵感只作选题素材，不进风格样本；AI 可提炼 3–5 个要点，点一个带到起草页；成品与来源的文字重合度 ≥ 67% 时提醒加入自己的观点
- TG 机器人（绑定后，全部按钮操作，发布前都要点确认）：
  - 📥 素材：直接发 tweets.js / .txt / .csv 文件（20MB 以内），或粘贴推文
  - 🎨 风格卡：查看、按字段修改、重新生成、历史版本恢复、总结修改习惯并采纳
  - ✍️ 起草 / 📜 长文：3 条候选 → 选一条 → 发布 / 定时 / 改写；单条长推、串推（列提纲 → 写全文 → 按段改「3 新内容」或让 AI「换 3」）、X 长文
  - 💡 灵感：看转发和频道收进来的内容、提炼要点、订阅 / 取消公开频道；🔖 X 书签同步、贴推文链接、写引用推文并发布
  - 💬 回复、📅 定时、📝 草稿（各种形式）；发布失败可一键重试（串推从断点继续）
  - ⚙️ 更多：推广链接（添加 / 默认 / 模式）、风格盲测、连接 X（机器人给出授权链接）
- 自动回复（审核后发）：拉取 @你的推文和你推文下的评论，用风格卡写 2–3 条回复候选；广告、攻击类内容 AI 自动标为跳过；每条回复由你选或改后确认发出，改过的会记进修改记录。可开启定时拉取，可设关键词 / 账号跳过规则和同一对话最多回复几轮

## 本地运行

```bash
npm install
cp .env.example .env.local   # 填入 ANTHROPIC_API_KEY
npm run dev                  # 打开 http://localhost:3000
```

没有配置 `ANTHROPIC_API_KEY` 时自动进入演示模式，候选和风格卡是固定的示例内容，可以先看界面和交互。

没有配置 `DATABASE_URL` 时，数据保存在项目里的 `.data` 文件夹（PGlite），本地运行不需要安装数据库。上线时填 Neon 等 Postgres 的连接串即可。数据表结构变更会在启动后自动迁移。

## 部署到服务器

任何能跑 Docker 的平台都行（仓库里有 `Dockerfile`，`railway.json` 是 Railway 的示例配置）。上线前请务必设置：

- `DATABASE_URL`（Postgres 连接串）
- `TOKEN_ENCRYPTION_KEY`（加密 X 令牌用，丢了令牌就读不出来）
- `ADMIN_EMAILS`（管理员邮箱，不设时最早注册的账号是管理员）
- `CRON_SECRET`、`TELEGRAM_WEBHOOK_SECRET`（至少 16 位随机字符，用 TG 机器人时需要）
- `PUBLIC_URL`、`X_REDIRECT_URI`（你的公开网址，X 开发者后台的回调地址要一致）

`.data/` 和 `.env*` 不要提交到仓库。服务前面有几层反向代理要告诉程序（`TRUSTED_PROXY_HOPS`），详见 [SECURITY.md](SECURITY.md)。

## 环境变量

| 变量 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API 密钥 |
| `CLAUDE_MODEL` | 可选，默认 `claude-opus-5-5` |
| `MOCK_LLM` | 设为 `1` 时强制演示模式 |
| `DATABASE_URL` | 可选，Postgres 连接串（例如 Neon）；不填则用本地 PGlite |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X 开发者后台 OAuth 2.0 的 Client ID 和 Client Secret |
| `X_REDIRECT_URI` | 可选，默认 `http://127.0.0.1:3000/api/x/callback`，需与开发者后台一致 |
| `X_MOCK` | 设为 `1` 时用模拟 X 账号，不会真的发帖 |
| `TOKEN_ENCRYPTION_KEY` | 加密 X 令牌的密钥；本地不填会自动生成在 `.data/secret.key`，线上必须填 |
| `TRUSTED_PROXY_HOPS` | 可选，前面有几层可信反向代理，默认 1 |
| `CRON_SECRET` | 线上部署时 Cron 调用 `/api/cron/tick` 用的密钥 |
| `TELEGRAM_BOT_TOKEN` | 平台共享 TG 机器人的 Token（@BotFather 创建）；也可在「灵感」页粘贴保存 |
| `TELEGRAM_WEBHOOK` / `TELEGRAM_WEBHOOK_SECRET` | 线上部署时设 `TELEGRAM_WEBHOOK=1` 改用 webhook（`/api/telegram/webhook`），本机默认用长轮询，不需要公网地址 |
| `ADMIN_EMAILS` | 可选，管理员邮箱（逗号分隔），能打开「后台」；不填时最早注册的账号是管理员 |

## 连接 X

1. 打开 [X 开发者后台](https://developer.x.com/en/portal/dashboard)，新建 App。
2. User authentication settings 里开启 OAuth 2.0：权限 **Read and write**，类型 **Web App**。
3. Callback URI 填 `http://127.0.0.1:3000/api/x/callback`（本机运行），Website URL 随便填。
4. 复制 OAuth 2.0 的 Client ID 和 Client Secret，粘贴到「发布」页的表单里保存（会写进本机 `.env.local`，立即生效，不用重启）；也可以自己写进 `.env.local` 后重启。
5. 到「发布」页点「连接 X 账号」。

只申请 `tweet.read tweet.write users.read offline.access` 四个权限。只用官方 API：发推、删推、读取提及；不做私信、关注、点赞、转推，不抓取 X。X API 按用量计费，发帖和读取提及都会消耗额度。

**定时任务**：本地运行时，应用启动后每 30 秒检查一次到点的定时帖子和需要拉取的提及（`src/instrumentation.ts`）。应用没开着时不会发，下次启动后立即补发。部署到 Vercel 等没有常驻进程的平台时，用 Cron 每分钟调用一次 `GET /api/cron/tick`，请求头带 `Authorization: Bearer <CRON_SECRET>`。

## 代码结构

```
src/db/schema.ts        数据表（Drizzle）；drizzle/ 里是迁移文件
src/db/index.ts         数据库连接，首次访问时自动迁移
src/lib/auth.ts         邮箱密码登录、会话
src/lib/import.ts       素材解析（X 存档、CSV、文本）与清洗规则
src/lib/data.ts         素材、风格卡版本、修改记录的读写
src/lib/style-card.ts   风格卡类型
src/lib/metrics.ts      风格统计指标（纯代码计算）
src/lib/text.ts         切句、拼句、X 加权字数、3-gram 相似度
src/lib/prompts.ts      提示词（集中管理，系统提示只放稳定内容以便缓存）
src/lib/llm.ts          Claude 调用（结构化输出、提示词缓存、拒绝时自动换模型）
src/lib/longform.ts     长文（串推 / X 长文）的提示词与生成
src/lib/x.ts            X 官方 API：OAuth 2.0（PKCE）、令牌刷新、发推、删推、拉取提及
src/lib/secret.ts       令牌加密（AES-256-GCM）
src/lib/publish.ts      发布任务：立即 / 定时、串推断点续发、重试、从 X 删除
src/lib/replies.ts      自动回复队列：拉取提及、跳过规则、生成候选、确认后发出
src/lib/scheduler.ts    后台定时器（定时发布、定时拉取提及、检查订阅的频道）
src/lib/telegram.ts     TG 机器人：绑定、接收转发、长轮询
src/lib/tg-bot.ts       TG 机器人里的功能：起草、发布、定时、灵感、回复（按钮）
src/lib/tg-api.ts       Telegram Bot API 底层调用
src/lib/tg-channel.ts   公开 TG 频道预览页解析
src/lib/inspiration.ts  灵感池：收录、去重、频道订阅
src/app/api/            接口
src/components/         页面组件（工作台、素材、风格卡、账号）
```

## 修改数据表

改 `src/db/schema.ts` 后运行 `npx drizzle-kit generate` 生成迁移文件并一起提交。
