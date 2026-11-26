import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "@/lib/rate-limit";

const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  it("没有代理头时算作 direct", () => {
    expect(clientIp(req({}))).toBe("direct");
  });

  it("客户端自己填的最左边的值不被采信，取最右一个", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("伪造 cf-connecting-ip / x-real-ip 无效", () => {
    expect(clientIp(req({ "cf-connecting-ip": "6.6.6.6", "x-real-ip": "7.7.7.7", "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "cf-connecting-ip": "6.6.6.6" }))).toBe("direct");
  });

  it("TRUSTED_PROXY_HOPS=2 时取倒数第二个", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
  });
});
