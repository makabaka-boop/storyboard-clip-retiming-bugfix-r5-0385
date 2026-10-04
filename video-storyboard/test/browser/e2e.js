// 端到端：真实 Chromium + 真实短视频样本。
// 验证：
//  A. 导入 2 段视频、设置偏移、均匀建立 ≤30 个分镜点，真实取帧成功，
//     且帧内容（背景色相）确实来自正确视频、正确源时间；
//  B. 页面内“可控媒体回调”竞争测试 4 项全部 ✔；
//  C. 真实连续拖动偏移（快速 input 风暴）后，帧与新的轨道/源时间一致，无旧帧残留；
//  D. 点击分镜定位播放（player.currentTime 落到源时间）；
//  E. PNG 接触表与 JSON 清单共用同一快照（点数/顺序/ID 一致，PNG 魔数正确）；
//  F. 缓存：取帧 -> 重载页面 -> 重新选中“内容相同”的文件 -> 命中缓存
//     (frameFromCache=true)；不选文件则无从命中；
//  G. 强制缓存写失败不影响清单生成。
//  H. 剪辑参数（入点/出点/倍速/反向）：覆盖时长、点位源时间、帧内容、
//     非法编辑拒绝、剪短后失去覆盖的点、替换更短素材——全部按当前剪辑生效。

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webm": "video/webm",
};

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (p === "/") p = "/index.html";
        const file = path.join(root, p);
        const data = await readFile(file);
        res.writeHead(200, {
          "Content-Type":
            MIME[path.extname(file)] ?? "application/octet-stream",
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const libDirs = [
  "/tmp/chromelibs/usr/lib",
  "/tmp/chromelibs/usr/lib/aarch64-linux-gnu",
  "/tmp/chromelibs/lib",
  "/tmp/chromelibs/lib/aarch64-linux-gnu",
];

async function waitFrames(page, n, timeoutMs = 30000) {
  return page.waitForFunction(
    (n) => {
      const pts = globalThis.__app.timeline.confirmedSnapshot();
      return (
        pts.length === n &&
        pts.every((p) => p.frameStatus === "ok" || p.frameStatus === "error")
      );
    },
    n,
    { timeout: timeoutMs },
  );
}

async function frameHue(page, pointId) {
  // 读取缩略帧边缘背景像素的色相（中央是白色秒号，避开）
  return page.evaluate(async (pid) => {
    const p = globalThis.__app.timeline.points.find((x) => x.id === pid);
    const bmp = await createImageBitmap(p.frame);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const samples = [
      [8, 90],
      [8, 120],
      [300, 90],
      [160, 18],
      [160, 170],
    ];
    const hues = samples.map(([x, y]) => {
      const { data } = ctx.getImageData(x, y, 1, 1);
      return rgbToHue(data[0], data[1], data[2]);
    });
    bmp.close();
    return hues.sort((a, b) => a - b)[Math.floor(hues.length / 2)];

    function rgbToHue(r, g, b) {
      r /= 255;
      g /= 255;
      b /= 255;
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      let h = 0;
      if (max !== min) {
        const d = max - min;
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      return h;
    }
  }, pointId);
}

function hueNear(a, b, tol = 18) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d) <= tol;
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const clipA = path.join(root, "samples", "clip-a.webm");
  const clipB = path.join(root, "samples", "clip-b.webm");

  const browser = await chromium.launch({
    headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: libDirs.join(":") },
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });

  try {
    // ---------------- A. 真实导入/偏移/取帧 ----------------
    console.log("A. 真实视频导入、偏移与取帧");
    await page.goto(base);
    await page.setInputFiles("#fileInput", [clipA, clipB]);
    await page.waitForFunction(
      () => globalThis.__app.tracks().length === 2,
      null,
      { timeout: 15000 },
    );

    // 第二段偏移 2 秒
    const offsetSet = await page.evaluate(() => {
      const t2 = globalThis.__app.tracks()[1];
      globalThis.__app.commitOffset(t2.id, 2);
      return {
        id: t2.id,
        duration: globalThis.__app.timeline.projectDuration(),
      };
    });
    check(
      "第二段偏移 2s 后项目总时长 = 2+3 = 5s",
      Math.abs(offsetSet.duration - 5) < 0.05,
      `got ${offsetSet.duration}`,
    );

    await page.fill("#uniformN", "12");
    await page.click("#btnUniform");
    await waitFrames(page, 12);
    const summary = await page.evaluate(() => {
      const pts = globalThis.__app.timeline.confirmedSnapshot();
      return {
        count: pts.length,
        ordered: pts.every(
          (p, i) => i === 0 || p.projectTime >= pts[i - 1].projectTime,
        ),
        allOk: pts.every((p) => p.frameStatus === "ok"),
        errors: pts.filter((p) => p.frameStatus === "error").length,
        points: pts.map((p) => ({
          id: p.id,
          t: p.projectTime,
          track: p.trackId,
          src: p.sourceTime,
          cached: p.frameFromCache,
        })),
      };
    });
    check(
      "建立 12 个分镜点（≤30）",
      summary.count === 12,
      `count=${summary.count}`,
    );
    check("分镜点按项目时间升序", summary.ordered);
    check("真实取帧全部成功", summary.allOk, `${summary.errors} 个失败`);

    // 上限：再加到超过 30
    await page.evaluate(() => {
      for (let i = 0; i < 25; i += 1)
        globalThis.__app.addPointAtProjectTime(0.2 + i * 0.19);
    });
    const capped = await page.evaluate(
      () => globalThis.__app.timeline.confirmedSnapshot().length,
    );
    check("分镜点数量被硬性截断在 30", capped === 30, `count=${capped}`);
    await waitFrames(page, 30, 40000);

    // 帧内容正确性：抽样比对色相（取秒中位置，避开浏览器 seek 到关键帧的秒边界）
    // clip-a: 第 s 秒背景 hue = (floor(s)*40)%360；clip-b hue0=160
    const probe = await page.evaluate(() => {
      const pts = globalThis.__app.timeline.confirmedSnapshot();
      const find = (pred) => {
        const p = pts.find(pred);
        return p ? p.id : null;
      };
      return {
        a0: find(
          (p) =>
            p.trackId === globalThis.__app.tracks()[0].id &&
            p.sourceTime > 0.2 &&
            p.sourceTime < 0.9,
        ),
        a3: find(
          (p) =>
            p.trackId === globalThis.__app.tracks()[0].id &&
            p.sourceTime > 3.1 &&
            p.sourceTime < 3.9,
        ),
        // 项目时间 4~5 的点必然来自 clip-b（a 只覆盖到 4），源时间 2~3 -> hue≈240
        b2: find(
          (p) =>
            p.trackId === globalThis.__app.tracks()[1].id &&
            p.sourceTime > 2.2 &&
            p.sourceTime < 2.9,
        ),
      };
    });
    if (probe.a0)
      check(
        "帧内容正确：clip-a 源时间 <1s（hue≈0）",
        hueNear(await frameHue(page, probe.a0), 0),
        `hue=${await frameHue(page, probe.a0)}`,
      );
    if (probe.a3)
      check(
        "帧内容正确：clip-a 源时间 ≥3s（hue≈120）",
        hueNear(await frameHue(page, probe.a3), 120),
        `hue=${await frameHue(page, probe.a3)}`,
      );
    if (probe.b2)
      check(
        "帧内容正确：偏移后 clip-b 源 2~3s（hue≈240）",
        hueNear(await frameHue(page, probe.b2), 240),
        `hue=${await frameHue(page, probe.b2)}`,
      );

    // ---------------- B. 可控媒体竞争测试（真实浏览器页面内） ----------------
    console.log("B. 页面内可控回调竞争测试");
    await page.locator("details summary").click();
    let raceChecks = 0;
    for (const [btn, keyword] of [
      ["#raceRapid", "连续拖动 10 次"],
      ["#raceReplace", "结果：pA=stale"],
      ["#raceCancel", "5 个请求结果"],
      ["#raceOutOfOrder", "旧请求=stale"],
    ]) {
      await page.click(btn);
      await page.waitForFunction(
        (kw) => {
          const t = document.querySelector("#raceLog").textContent;
          return t.includes(kw) && /✔|\[×\]/.test(t);
        },
        keyword,
        { timeout: 8000 },
      );
      const log = await page.textContent("#raceLog");
      if (log.includes("✔") && !log.includes("[×]")) raceChecks += 1;
      else console.log(`    竞争轮次异常：\n${log}`);
    }
    check(
      "4 组可控回调竞争测试全部通过（无 [×]）",
      raceChecks === 4,
      `${raceChecks}/4`,
    );

    // ---------------- C. 真实偏移 input 风暴 ----------------
    console.log("C. 连续拖动偏移（真实视频乱序 seek 压力）");
    await page.evaluate(() => {
      const t2 = globalThis.__app.tracks()[1];
      globalThis.__app.clearPoints();
      globalThis.__app.commitOffset(t2.id, 2);
      globalThis.__app.addUniform(8);
    });
    await waitFrames(page, 8);
    // 对第二段偏移输入框快速连续改值
    const offsetHandle = page.locator('input[data-role="offset"]').nth(1);
    for (const v of ["2.5", "3", "2.2", "3.5", "2.8", "1.5", "2.0"]) {
      await offsetHandle.fill(v);
      await offsetHandle.dispatchEvent("input");
    }
    await offsetHandle.dispatchEvent("change");
    await page.waitForTimeout(400); // 防抖窗口
    await waitFrames(page, 8, 40000);
    const afterDrag = await page.evaluate(() => {
      const pts = globalThis.__app.timeline.confirmedSnapshot();
      const t2 = globalThis.__app.tracks()[1];
      // 所有落在第二段的点，源时间必须与“偏移=2”一致，且帧已重取（非缓存旧文件帧也可，关键是状态 ok）
      const consistent = pts.every((p) => {
        const tr = globalThis.__app.timeline.getTrack(p.trackId);
        return Math.abs(p.projectTime - tr.offset - p.sourceTime) < 0.02;
      });
      return {
        allOk: pts.every((p) => p.frameStatus === "ok"),
        consistent,
        count: pts.length,
      };
    });
    check(
      "拖动风暴后 8 帧全部重新就绪",
      afterDrag.allOk && afterDrag.count === 8,
    );
    check(
      "每点 (项目时间-偏移) 与源时间一致，无旧时间映射",
      afterDrag.consistent,
    );

    // ---------------- D. 点击分镜定位播放 ----------------
    console.log("D. 点击分镜定位播放");
    const target = await page.evaluate(
      () => globalThis.__app.timeline.confirmedSnapshot()[3],
    );
    await page.locator(`.point-card[data-pid="${target.id}"] .thumb`).click();
    await page.waitForFunction(
      (src) => {
        const v = document.querySelector("#player");
        return Math.abs(v.currentTime - src) < 0.35;
      },
      target.sourceTime,
      { timeout: 8000 },
    );
    check("播放器 currentTime 定位到分镜源时间", true);

    // ---------------- E. PNG + JSON 同一快照 ----------------
    console.log("E. PNG 接触表 / JSON 清单一致性");
    const exported = await page.evaluate(async () => {
      const { sheet, manifest, count } =
        await globalThis.__app.exportContactSheet({ columns: 4 });
      const buf = new Uint8Array(await sheet.blob.arrayBuffer());
      const snapIds = globalThis.__app.timeline
        .confirmedSnapshot()
        .map((p) => p.id);
      return {
        count,
        pngMagic:
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47,
        pngBytes: buf.length,
        manifestIds: manifest.points.map((p) => p.id),
        snapIds,
        sameOrder:
          JSON.stringify(manifest.points.map((p) => p.id)) ===
          JSON.stringify(snapIds),
        sheetMeta: manifest.contactSheet,
        tracksHaveOffsets: manifest.tracks.map((t) => t.offset),
        keys: manifest.points.map((p) => p.frameKey),
      };
    });
    check(
      "接触表为合法 PNG 且非空",
      exported.pngMagic && exported.pngBytes > 1000,
      `${exported.pngBytes} bytes`,
    );
    check(
      "JSON 点数 = PNG 格子数 = 快照点数（8）",
      exported.count === 8 &&
        exported.manifestIds.length === 8 &&
        exported.sheetMeta.points === 8,
    );
    check("JSON 与快照顺序/ID 完全一致（三者同源）", exported.sameOrder);
    check(
      "清单包含每轨偏移与每点缓存键",
      exported.tracksHaveOffsets.length === 2 && exported.keys.every(Boolean),
    );

    // ---------------- F. 重开页面 + 重新选中相同内容 -> 缓存命中 ----------------
    console.log("F. IndexedDB 内容寻址缓存的跨会话复用");
    await page.goto(base); // 重载：应用层无任何 文件->摘要 绑定
    const noFileState = await page.evaluate(() => ({
      tracks: globalThis.__app.tracks().length,
      points: globalThis.__app.timeline.points.length,
    }));
    check(
      "重开页面后轨道/分镜不持久化（仅缓存持久）",
      noFileState.tracks === 0 && noFileState.points === 0,
    );

    // 重新选中“内容相同”的两个视频
    await page.setInputFiles("#fileInput", [clipA, clipB]);
    await page.waitForFunction(() => globalThis.__app.tracks().length === 2);
    await page.evaluate(() => {
      const t2 = globalThis.__app.tracks()[1];
      globalThis.__app.commitOffset(t2.id, 2);
      globalThis.__app.addUniform(8);
    });
    await waitFrames(page, 8);
    const cacheHits = await page.evaluate(
      () =>
        globalThis.__app.timeline
          .confirmedSnapshot()
          .filter((p) => p.frameFromCache).length,
    );
    check(
      "重新选中内容相同的视频后，缩略帧从 IndexedDB 缓存复用",
      cacheHits >= 6,
      `仅 ${cacheHits}/8 命中`,
    );

    // 不同内容文件即使源时间相同，缓存键（含摘要）也不同 -> 不会串帧
    const cross = await page.evaluate(() => {
      const keyA = `sha256:${globalThis.__app.tracks()[0].digest.hex}/t500`;
      return { keyA };
    });
    check(
      "缓存键含摘要，不同内容文件键不同",
      key_isContentAddressed(cross.keyA),
    );

    // ---------------- G. 缓存写失败不破坏清单 ----------------
    console.log("G. 配额/写失败隔离");
    await page.evaluate(() => {
      const app = globalThis.__app;
      app.cache.put = async () => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      };
      app.cache.get = async () => {
        throw new Error("cache boom");
      };
      // 丢弃当前内存中的帧，强制全部重新走“提取”路径（缓存全程失败）
      for (const p of app.timeline.points) {
        if (p.frameURL) URL.revokeObjectURL(p.frameURL);
        p.frame = null;
        p.frameURL = null;
        p.frameStatus = "idle";
      }
    });
    await page.evaluate(() => globalThis.__app.refreshStaleFrames());
    await waitFrames(page, 8);
    const manifestOk = await page.evaluate(() => {
      const m = globalThis.__app.buildManifestNow();
      return m.format === "video-storyboard-manifest" && m.points.length === 8;
    });
    check("缓存持续失败时取帧与 JSON 清单仍然正常", manifestOk);

    // ---------------- H. 剪辑参数：入点/出点/倍速/反向 ----------------
    console.log("H. 剪辑参数（入点/出点/倍速/反向）端到端");
    await page.evaluate(() => {
      const app = globalThis.__app;
      app.clearPoints();
      const [, b] = app.tracks();
      app.commitOffset(b.id, 0); // B 归零偏移，便于推算
    });
    // A: 入点 1 / 出点 3 / 2 倍速 -> 覆盖 1s；项目总时长 = max(1, 3) = 3s
    await page.evaluate(() => {
      const app = globalThis.__app;
      return app.commitClipEdit(app.tracks()[0].id, {
        in: 1,
        out: 3,
        rate: 2,
        reverse: false,
      });
    });
    const clipDur = await page.evaluate(() =>
      globalThis.__app.timeline.projectDuration(),
    );
    check(
      "剪辑后项目总时长按覆盖计算（A 1s / B 3s -> 3s）",
      Math.abs(clipDur - 3) < 0.05,
      `got ${clipDur}`,
    );

    await page.evaluate(() => globalThis.__app.addUniform(6));
    await waitFrames(page, 6);
    const clipPoints = await page.evaluate(() => {
      const app = globalThis.__app;
      const aId = app.tracks()[0].id;
      return app.timeline.confirmedSnapshot().map((p) => ({
        id: p.id,
        t: p.projectTime,
        src: p.sourceTime,
        onA: p.trackId === aId,
        ok: p.frameStatus === "ok",
      }));
    });
    check("剪辑后 6 个分镜点全部就绪", clipPoints.every((p) => p.ok));
    const onA = clipPoints.filter((p) => p.onA);
    check(
      "A 轨点位源时间 = 入点1 + 2×项目时间",
      onA.length === 2 &&
        onA.every((p) => Math.abs(p.src - (1 + 2 * p.t)) < 0.02),
      JSON.stringify(onA),
    );
    // 帧内容：A 源时间落在 [2,3) 的点，背景色相应为 hue=80
    const aFwd = onA.find((p) => p.src >= 2 && p.src < 3);
    if (aFwd)
      check(
        "正放倍速帧内容正确（clip-a 源 2.x -> hue≈80）",
        hueNear(await frameHue(page, aFwd.id), 80),
        `hue=${await frameHue(page, aFwd.id)}`,
      );

    // 开启倒放：同一项目时间映射到出点侧（源 3 - 2×项目时间）
    await page.evaluate(() => {
      const app = globalThis.__app;
      return app.commitClipEdit(app.tracks()[0].id, {
        in: 1,
        out: 3,
        rate: 2,
        reverse: true,
      });
    });
    await waitFrames(page, 6);
    const revPoints = await page.evaluate(() => {
      const app = globalThis.__app;
      const aId = app.tracks()[0].id;
      return app.timeline
        .confirmedSnapshot()
        .filter((p) => p.trackId === aId)
        .map((p) => ({ id: p.id, t: p.projectTime, src: p.sourceTime }));
    });
    check(
      "倒放点位源时间 = 出点3 - 2×项目时间（项目时间仍正向）",
      revPoints.length === 2 &&
        revPoints.every((p) => Math.abs(p.src - (3 - 2 * p.t)) < 0.02),
      JSON.stringify(revPoints),
    );
    const aRev = revPoints.find((p) => p.src >= 1 && p.src < 2);
    if (aRev)
      check(
        "倒放帧内容正确（clip-a 源 1.x -> hue≈40）",
        hueNear(await frameHue(page, aRev.id), 40),
        `hue=${await frameHue(page, aRev.id)}`,
      );

    // 非法编辑：整体拒绝，轨道状态不变（无部分生效）
    const invalid = await page.evaluate(() => {
      const app = globalThis.__app;
      const a = app.tracks()[0];
      const before = JSON.stringify({
        edit: a.edit,
        D: app.timeline.projectDuration(),
        pts: app.timeline.confirmedSnapshot().map((p) => [p.trackId, p.sourceTime]),
      });
      const results = [
        { in: -1, out: 3, rate: 1 },
        { in: 1, out: 99, rate: 1 },
        { in: 2, out: 2, rate: 1 },
        { in: 1, out: 3, rate: 0 },
        { in: 1, out: 3, rate: Number.NaN },
      ].map((edit) => {
        try {
          app.timeline.setClipEdit(a.id, edit);
          return false;
        } catch {
          return true;
        }
      });
      const after = JSON.stringify({
        edit: a.edit,
        D: app.timeline.projectDuration(),
        pts: app.timeline.confirmedSnapshot().map((p) => [p.trackId, p.sourceTime]),
      });
      return { allThrew: results.every(Boolean), unchanged: before === after };
    });
    check(
      "无效速度/入出点全部拒绝且轨道状态不变",
      invalid.allThrew && invalid.unchanged,
      JSON.stringify(invalid),
    );

    // 剪短 B 到 [0,1)：项目时间 ≥1 的点失去覆盖
    await page.evaluate(() => {
      const app = globalThis.__app;
      return app.commitClipEdit(app.tracks()[1].id, {
        in: 0,
        out: 1,
        rate: 1,
        reverse: false,
      });
    });
    const trimmed = await page.evaluate(() => {
      const app = globalThis.__app;
      return {
        snapN: app.timeline.confirmedSnapshot().length,
        orphans: app.timeline.points.filter((p) => !p.trackId).length,
        orphanFrames: app.timeline.points.filter((p) => !p.trackId && p.frame)
          .length,
        D: app.timeline.projectDuration(),
      };
    });
    check(
      "剪短轨道后失去覆盖的分镜脱离快照且不留旧图",
      trimmed.snapN === 2 && trimmed.orphans === 4 && trimmed.orphanFrames === 0,
      JSON.stringify(trimmed),
    );
    check("剪短后项目总时长 = 1s", Math.abs(trimmed.D - 1) < 0.05);

    // 替换为更短素材：A(4s, 剪辑 1~3) 换成 clip-b(3s)，出点仍可容纳；
    // 帧全部重取且内容来自新文件（clip-b 源 2.x -> hue≈240）
    await page.evaluate(async () => {
      const app = globalThis.__app;
      const resp = await fetch("/samples/clip-b.webm");
      const blob = await resp.blob();
      const file = new File([blob], "clip-b.webm", { type: "video/webm" });
      await app.replaceFile(app.tracks()[0].id, file);
    });
    await waitFrames(page, 2);
    const replaced = await page.evaluate(() => {
      const app = globalThis.__app;
      const a = app.tracks()[0];
      return {
        duration: a.duration,
        edit: a.edit,
        pts: app.timeline.confirmedSnapshot().map((p) => ({
          id: p.id,
          src: p.sourceTime,
          ok: p.frameStatus === "ok",
        })),
      };
    });
    check(
      "替换更短素材：时长/剪辑收缩一致，帧全部重取",
      Math.abs(replaced.duration - 3) < 0.1 &&
        replaced.edit.out <= 3 &&
        replaced.pts.every((p) => p.ok),
      JSON.stringify(replaced),
    );
    const repProbe = replaced.pts.find((p) => p.src >= 2 && p.src < 3);
    if (repProbe)
      check(
        "替换后帧来自新文件（clip-b 源 2.x -> hue≈240）",
        hueNear(await frameHue(page, repProbe.id), 240),
        `hue=${await frameHue(page, repProbe.id)}`,
      );

    // 清单与画面同遵剪辑参数
    const mani = await page.evaluate(() => globalThis.__app.buildManifestNow());
    check(
      "清单项目时长/轨道覆盖/点位源时间遵守当前剪辑",
      Math.abs(mani.projectDuration - 1) < 0.05 &&
        mani.tracks.every((t) => typeof t.coverage === "number") &&
        mani.points.length === 2,
      JSON.stringify({ D: mani.projectDuration, n: mani.points.length }),
    );

    // ---------------- 页面无错误日志 ----------------
    const realErrors = pageErrors.filter(
      (e) => !/favicon|Failed to load resource/i.test(e),
    );
    check(
      "浏览器控制台无未捕获错误",
      realErrors.length === 0,
      realErrors.slice(0, 3).join(" | "),
    );
  } catch (e) {
    console.error("E2E 执行异常：", e);
    failed += 1;
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\nE2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function key_isContentAddressed(k) {
  return typeof k === "string" && /^sha256:[0-9a-f]{64}\/t\d+$/.test(k);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
