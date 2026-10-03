import test from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/app.js";
import { FrameExtractor } from "../../src/extractor.js";
import { FrameCache } from "../../src/cache.js";
import { makeHarness } from "../fakes.js";

globalThis.__FrameExtractor = FrameExtractor;

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeApp() {
  const h = makeHarness({ auto: false, seekTimeout: 200 });
  const extractor = new FrameExtractor({
    createMedia: h.createMedia,
    createCanvas: h.createCanvas,
    concurrency: 3,
    seekTimeout: 200,
  });
  const app = new App({ extractor, cache: new FrameCache() });
  return { app, h };
}

function addTrackWithFile(app, { duration = 10, digest = "A" } = {}) {
  const track = app.timeline.addTrack({
    name: "clip",
    digest,
    duration,
    width: 320,
    height: 180,
  });
  app.files.set(track.id, {
    url: `blob://file-${digest}`,
    file: null,
    bytes: 0,
    digest: { algo: "sha256", hex: digest },
  });
  return track;
}

test("编辑期间在途取帧：旧源时间的帧不得提交，新剪辑参数下重取", async () => {
  const { app, h } = makeApp();
  const t = addTrackWithFile(app);
  app.addPointAtProjectTime(2); // 源时间 2，开始取帧
  await tick(); // capture#1 进入在途（等待媒体回调）
  const p = app.timeline.points[0];
  assert.equal(p.frameStatus, "loading");
  assert.equal(p.sourceTime, 2);

  // 取帧途中应用剪辑：4 倍速 -> 项目 2s 对应源 8s
  const commit = app.commitClipEdit(t.id, { in: 0, out: 10, rate: 4 });
  await tick(); // 让重取帧请求发出
  assert.equal(p.sourceTime, 8);
  assert.equal(p.frameStatus, "loading", "新源时间重新进入取帧");

  await h.env.drain(); // 派发全部媒体回调（含旧请求乱序晚到）
  await commit;
  await tick();

  assert.equal(p.frameStatus, "ok");
  assert.equal(p.frame.__mark.time, 8, "提交的帧必须属于新源时间 8s");
  assert.equal(p.frame.__mark.url, "blob://file-A");
});

test("剪短轨道使点失去覆盖：在途旧帧被丢弃，且不再发起任何取帧", async () => {
  const { app, h } = makeApp();
  const t = addTrackWithFile(app);
  app.addPointAtProjectTime(8);
  await tick(); // capture#1 在途（源时间 8）
  const p = app.timeline.points[0];
  assert.equal(p.frameStatus, "loading");

  // 把出点剪到 5s：项目 8s 失去覆盖
  await app.commitClipEdit(t.id, { in: 0, out: 5, rate: 1 });
  assert.equal(p.sourceTime, null);
  assert.equal(p.frameStatus, "idle");

  const mediaBefore = h.created.length;
  await h.env.drain(); // 旧取帧回调晚到
  await tick();
  assert.equal(p.frame, null, "在途旧帧不得提交给失去覆盖的点");
  assert.equal(p.frameStatus, "idle");

  // 补帧调度与手动重试都不得为失去覆盖的点取帧
  await app.refreshStaleFrames();
  await app.ensurePointFrame(p);
  await tick();
  assert.equal(h.created.length, mediaBefore, "没有为失去覆盖的点创建新媒体");
  assert.equal(p.frame, null);
});

test("恢复覆盖后自动按当前剪辑参数重取", async () => {
  const { app, h } = makeApp();
  const t = addTrackWithFile(app);
  app.addPointAtProjectTime(8);
  await h.env.drain();
  await tick();
  const p = app.timeline.points[0];
  assert.equal(p.frameStatus, "ok");
  assert.equal(p.frame.__mark.time, 8);

  await app.commitClipEdit(t.id, { in: 0, out: 5, rate: 1 }); // 失去覆盖
  assert.equal(p.sourceTime, null);

  // 重新放开出点并倒放：项目 8s -> 源 10-8*1=2s
  const commit = app.commitClipEdit(t.id, {
    in: 0,
    out: 10,
    rate: 1,
    reverse: true,
  });
  await tick();
  await h.env.drain();
  await commit;
  await tick();
  assert.equal(p.sourceTime, 2);
  assert.equal(p.frameStatus, "ok");
  assert.equal(p.frame.__mark.time, 2, "恢复覆盖后按倒放映射重取");
});

test("导出期间三者同源：剪辑后的快照同时驱动清单与定位", async () => {
  const { app, h } = makeApp();
  const t = addTrackWithFile(app);
  await app.commitClipEdit(t.id, { in: 1, out: 9, rate: 2 }); // 覆盖 [0,4)
  app.addPointAtProjectTime(1); // 源 1+1*2=3
  app.addPointAtProjectTime(3); // 源 7
  await h.env.drain();
  await tick();

  const m = app.buildManifestNow();
  assert.equal(m.projectDuration, 4);
  assert.deepEqual(
    m.points.map((p) => p.sourceTime),
    [3, 7],
  );
  assert.ok(m.points.every((p) => p.frameReady));

  const snap = app.timeline.confirmedSnapshot();
  const loc = app.locatePlayback(snap[1]);
  assert.equal(loc.sourceTime, 7, "定位播放与清单使用同一源时间");
  assert.equal(loc.url, "blob://file-A");
});

test("编辑前的缓存结果晚到：不得覆盖新源时间的帧", async () => {
  // 可控缓存：get 挂起，由测试手动兑现，模拟 IndexedDB 慢返回
  const pending = new Map();
  const cache = {
    get: (key) =>
      new Promise((res) => {
        pending.set(key, res);
      }),
    put: async () => {},
    usage: async () => ({ entries: 0, bytes: 0, degraded: true }),
    clear: async () => {},
  };
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const app = new App({
    extractor: h.makeExtractor({ concurrency: 2 }),
    cache,
  });
  const t = addTrackWithFile(app);
  app.addPointAtProjectTime(2); // 源 2 -> 取帧#1 -> cache.get(key2) 挂起
  await tick();
  const p = app.timeline.points[0];
  const key2 = p.frameKey;
  assert.match(key2, /t2000$/);

  // 编辑：4 倍速 -> 源 8 -> 取帧#2 -> cache.get(key8) 挂起
  const commit = app.commitClipEdit(t.id, { in: 0, out: 10, rate: 4 });
  await tick();
  const key8 = p.frameKey;
  assert.match(key8, /t8000$/);

  // 旧键的缓存结果晚到：不得被采纳（编辑前的缓存不能覆盖新帧）
  const oldBlob = new Blob(["old"]);
  pending.get(key2)(oldBlob);
  await tick();
  assert.notEqual(p.frame, oldBlob);
  assert.equal(p.frameStatus, "loading", "仍在等待新源时间的帧");

  // 新键缓存命中 -> 采纳
  const newBlob = new Blob(["new"]);
  pending.get(key8)(newBlob);
  await commit;
  await tick();
  assert.equal(p.frame, newBlob);
  assert.equal(p.frameStatus, "ok");
  assert.equal(p.frameFromCache, true);
});

test("新一次取帧还停在缓存查找时，旧在途提取帧不得提交", async () => {
  // 新键的 cache.get 挂起（由测试手动放行）；旧源时间的 extractor 在途帧先完成
  let releaseGet = null;
  const cache = {
    get: (key) =>
      key.endsWith("t8000")
        ? new Promise((res) => {
            releaseGet = res;
          })
        : Promise.resolve(null),
    put: async () => {},
    usage: async () => ({ entries: 0, bytes: 0, degraded: true }),
    clear: async () => {},
  };
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const app = new App({
    extractor: h.makeExtractor({ concurrency: 2 }),
    cache,
  });
  const t = addTrackWithFile(app);
  app.addPointAtProjectTime(2); // 源 2：缓存未命中 -> extractor 在途
  await tick();
  const p = app.timeline.points[0];
  assert.equal(p.frameStatus, "loading");

  // 编辑改变源时间 -> 取帧#2 发起但卡在缓存查找；旧 extractor 任务仍在途
  const commit = app.commitClipEdit(t.id, { in: 0, out: 10, rate: 4 });
  await tick();
  assert.ok(releaseGet, "取帧#2 已停在缓存查找");
  await h.env.drain(); // 旧取帧（源 2）的媒体回调全部到达
  await tick();
  assert.equal(p.frame, null, "旧源时间的在途帧不得提交");
  assert.equal(p.frameStatus, "loading");

  // 放行新键缓存（未命中）-> 走 extractor 重新取源 8
  releaseGet(null);
  await h.env.drain();
  await commit;
  await tick();
  assert.equal(p.frameStatus, "ok");
  assert.equal(p.frame.__mark.time, 8);
});
