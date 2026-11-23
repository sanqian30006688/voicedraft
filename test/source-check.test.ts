/** 自动发帖的代码检查：原文够不够写、帖子有没有停在半句、哪些词用得太多 */
import { describe, expect, it } from "vitest";
import { isPromoLink } from "@/lib/autopilot";
import { firstUrl, isAdult, joinThread, looksCut, postShape, splitThread, overusedPhrases, overuseHits, sourceProblem, substance } from "@/lib/source-check";

describe("原文够不够写", () => {
  it("只有链接、表情、@ 和话题标签的不写", () => {
    expect(sourceProblem("Big news 👇 https://t.co/abc @someone #AI")).toContain("信息太少");
    expect(sourceProblem("GM ☀️")).toContain("信息太少");
    expect(sourceProblem("RT @foo: something long enough to read and understand here for sure yes")).toContain("转推");
    expect(sourceProblem("有位研究员说，城市里的行道树每多一成，夏天街面温度能降两度左右。")).toBeNull();
    expect(sourceProblem("OpenAI released a new model today that can read whole codebases and fix bugs on its own")).toBeNull();
    expect(substance("你好 https://a.com/very/long/path/that/should/not/count")).toBe(2);
    expect(firstUrl("看这个 https://t.co/abc）")).toBe("https://t.co/abc");
  });
});

describe("帖子有没有说完", () => {
  it("停在逗号、冒号、省略号、连词上算没说完", () => {
    expect(looksCut("我觉得这件事最值得说的是，")).toBe(true);
    expect(looksCut("说到底还是要看：")).toBe(true);
    expect(looksCut("这事没那么简单…")).toBe(true);
    expect(looksCut("先把小事做完，因为")).toBe(true);
    expect(looksCut("先把小事做完再说。")).toBe(false);
    expect(looksCut("这就是我想说的")).toBe(false);
    expect(looksCut("好开心~")).toBe(false);
    // 附上的原文链接和推广行不算正文
    expect(looksCut("先把小事做完再说。\nhttps://news.example.com/p/1")).toBe(false);
    expect(looksCut("先把小事做完再说 🙂 #创业")).toBe(false);
    expect(looksCut("先把小事做完再说。\n进群「交流」：12345", ["12345"])).toBe(false);
  });
});

describe("用得太多的词", () => {
  it("在很多条里反复出现的词会被找出来，常用词不算", () => {
    const posts = [
      "说白了，小团队最重要的是专注。",
      "说白了，融资不是目的。",
      "说白了，用户才是老板。",
      "今天天气不错，出去走走。",
      "说白了，我们自己要先想清楚。",
      "周末读完了一本书，挺好。",
    ];
    const hot = overusedPhrases(posts);
    expect(hot).toContain("说白了");
    expect(hot).not.toContain("说白");
    expect(hot).not.toContain("我们");
    expect(overuseHits("说白了，先做再说", hot)).toEqual(["说白了"]);
    expect(overusedPhrases(posts.slice(0, 3))).toEqual([]);
  });
});

describe("评论区放什么链接", () => {
  it("别人的群、社交主页、短链、带邀请码的都不放；官网、文档、GitHub、文章可以", () => {
    for (const u of [
      "https://t.me/somegroup",
      "https://discord.gg/abc",
      "https://x.com/someone",
      "https://www.youtube.com/watch?v=1",
      "https://linktr.ee/someone",
      "https://bit.ly/3abc",
      "https://www.binance.com/register?ref=ABC123",
      "https://app.example.com/invite/xyz",
      "https://shop.example.com/item?aff=99",
      "https://qm.qq.com/q/abc",
    ])
      expect(isPromoLink(u), u).toBe(true);
    for (const u of [
      "https://openai.com/blog/new-model",
      "https://docs.example.com/guide/install",
      "https://github.com/someone/tool",
      "https://guide.example.org/pi-photos",
      "https://news.example.com/p/1?utm_source=x",
    ])
      expect(isPromoLink(u), u).toBe(false);
  });
});

describe("写多长", () => {
  it("短原文一条；长原文会员写长推、不是会员写串推；关掉就最多一条", () => {
    const short = "某市地铁明年开始周末通宵运营，先试点两条线路。";
    const long = "城南一家社区书店靠每周两次读书会活了下来，会员费刚好覆盖房租。".repeat(12);
    expect(postShape(short, { premium: true, allowLong: true }).kind).toBe("single");
    expect(postShape(long, { premium: false, allowLong: true })).toMatchObject({ kind: "thread", min: 2 });
    expect(postShape(long, { premium: true, allowLong: true }).kind).toBe("long");
    expect(postShape(long, { premium: false, allowLong: false }).kind).toBe("single");
    expect(postShape(long.repeat(5), { premium: false, allowLong: true })).toMatchObject({ kind: "thread", min: 4 });
  });

  it("串推用单独一行 --- 分开", () => {
    const t = joinThread(["第一条", "第二条", " "]);
    expect(splitThread(t)).toEqual(["第一条", "第二条"]);
    expect(splitThread("只有一条")).toEqual(["只有一条"]);
    expect(splitThread("a\n---\nb\n  ----  \nc")).toEqual(["a", "b", "c"]);
  });
});

describe("X 会员", () => {
  it("Basic / Premium / Premium+ 算会员；没有订阅字段时看蓝标", async () => {
    const { parsePremium } = await import("@/lib/x");
    expect(parsePremium({ subscription_type: "Premium" })).toBe(true);
    expect(parsePremium({ subscription_type: "PremiumPlus" })).toBe(true);
    expect(parsePremium({ subscription_type: "Basic" })).toBe(true);
    expect(parsePremium({ subscription_type: "None", verified_type: "blue" })).toBe(false);
    expect(parsePremium({ verified_type: "blue" })).toBe(true);
    expect(parsePremium({})).toBe(false);
  });
});

describe("色情过滤", () => {
  it("明显的色情 / 成人内容不写；正常内容不误伤", () => {
    expect(isAdult("今晚福利姬直播，私信领取")).toBe(true);
    expect(isAdult("Check my OnlyFans")).toBe(true);
    expect(sourceProblem("这里有最新的成人视频合集，点链接免费看完整版，还有更多精彩内容等你来看哦")).toContain("色情");
    expect(isAdult("今天的露点温度很高，体感闷热")).toBe(false);
    expect(isAdult("某xxx公司发布了新产品")).toBe(false);
    expect(isAdult("被现实啪啪打脸")).toBe(false);
  });
});

describe("TG 频道图片", () => {
  it("预览页里的图片地址能取出来", async () => {
    const { parseChannelHtml } = await import("@/lib/tg-channel");
    const html = `<div data-post="news/12"><a class="tgme_widget_message_photo_wrap blabla" style="width:800px;background-image:url('https://cdn4.cdn-telegram.org/file/abc.jpg')"></a>
      <div class="tgme_widget_message_text js-message_text">某产品今天上线了新功能，支持离线同步。</div><time datetime="2026-11-13T10:00:00+00:00"></time></div>`;
    const page = parseChannelHtml("news", html);
    expect(page.posts[0].media).toEqual(["https://cdn4.cdn-telegram.org/file/abc.jpg"]);
  });
});
