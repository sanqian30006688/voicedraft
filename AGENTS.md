<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 给用户的更新公告

用户能感觉到的新功能 / 变化，在 `src/lib/changelog.ts` 的 `CHANGELOG` 最前面加一条（id 唯一、title 和 text 用用户的说法、告诉他在机器人哪里点）。上线后机器人会自动把新记录合成一条「📢 功能更新」：默认先发到管理员 TG 审核，点了才群发（后台「功能更新和公告」可改成自动发或关闭）。修 bug、纯后台、只给管理员用的改动不用写。
