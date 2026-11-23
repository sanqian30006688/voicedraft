import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // 服务端专用标记在测试里不需要
      "server-only": path.resolve(__dirname, "test/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 每个测试文件一个独立的内存数据库
    pool: "forks",
  },
});
