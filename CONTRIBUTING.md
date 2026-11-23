# 参与贡献

1. 改代码前先开 Issue 说一下想做什么。
2. 提 PR 前本地跑 `npm test`、`npm run lint`、`npm run typecheck`，CI 也会跑。
3. 新增按用户存数据的表，请同时补一条多用户隔离测试（参考 `test/` 里已有的写法）。
4. 改数据表后运行 `npx drizzle-kit generate`，迁移文件一起提交。
5. 不要提交任何密钥、令牌、个人信息。
