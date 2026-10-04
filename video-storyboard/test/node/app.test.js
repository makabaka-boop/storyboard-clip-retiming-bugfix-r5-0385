import test from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/app.js";
import { FrameExtractor } from "../../src/extractor.js";
import { makeHarness, FakeCanvas } from "../fakes.js";

globalThis.__FrameExtractor = FrameExtractor;

// node 环境下没有 objectURL，补一个确定性的假实现
if (typeof URL.createObjectURL !== "function") {
  let n = 0;
  URL.createObjectURL = () => `blob:fake-${(n += 1)}`;
  URL.revokeObjectURL = () => {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nullCache(overrides = {}) {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    clear: async () => {},
    usage: async () => ({ entries: 0, bytes: 0, degraded: true }),
    ...overrides,
  };
}

function makeApp({ auto = false, cache } = {}) {
  const h = makeHarness({ auto, seekTimeout: 500 });
  const ex = h.makeExtractor({ concurrency: 3 });
  const app = new App({ extractor: ex, cache: cache ?? nullCache() });
  return { app, h, ex };
}

function addTrack(app, { duration = 10, digest = { algo: "sha256", hex: "AAA" } } = {}) {
  const tr = app.timeline.addTrack({
    name: "clip",
    digest,
    duration,
    width: 320,
    height: 180,
  });
  app.files.set(tr.id, { url: `blob://${digest.hex}`, file: null, digest });
  return tr;
}

test("编辑期间尚未完成的取帧：旧源时间的在途帧不得提交到新分镜", async () => {
  const { app, h } = makeApp();
  const tr = addTrack(app);
  const p = app.timeline.addPoint(5).point; // 源时间 5

  FakeCanvas.toBlobDelay = 20;
  try {
    const inflight = app.ensurePointFrame(p);
    await h.env.drain(); // 旧任务已 seek(5) 并画出，toBlob 还在路上

    // 剪辑：入点 1 -> 同一项目时间的源时间变为 6；帧立即作废（不触发补帧）
    app.timeline.setClipEdit(tr.id, { in: 1, out: 9, rate: 1, reverse: false });
    assert.equal(p.sourceTime, 6);
    assert.equal(p.frameStatus, "stale");

    await sleep(40); // 旧 toBlob 返回（源时间 5 的帧）
    await inflight;
    assert.equal(p.frame, null, "编辑前的在途帧绝不允许提交");
    assert.equal(p.frameStatus, "stale");

    // 上层补帧：新源时间 6 的帧正常到位
    const refreshed = app.refreshStaleFrames();
    await h.env.drain();
    await refreshed;
    assert.equal(p.frameStatus, "ok");
    assert.equal(p.frame.__mark.time, 6);
  } finally {
    FakeCanvas.toBlobDelay = 0;
  }
});

test("修改前的缓存结果不得覆盖新的帧（慢缓存竞态）", async () => {
  const pending = new Map(); // key -> resolve
  const cache = nullCache({
    get(key) {
      return new Promise((res) => pending.set(key, res));
    },
  });
  const { app, h } = makeApp({ cache });
  const tr = addTrack(app);
  const p = app.timeline.addPoint(5).point;

  const inflight = app.ensurePointFrame(p); // 查 sha256:AAA/t5000，挂起
  assert.ok(pending.has("sha256:AAA/t5000"));

  // 应用剪辑（in=1 -> 源时间 6）：旧帧作废，自动补帧去查新键
  const editDone = app.commitClipEdit(tr.id, {
    in: 1,
    out: 9,
    rate: 1,
    reverse: false,
  });
  assert.ok(pending.has("sha256:AAA/t6000"), "补帧必须按新源时间查键");

  // 旧键的缓存结果此刻才返回——属于修改前的时间，不得提交
  const staleBlob = new Blob(["old"]);
  pending.get("sha256:AAA/t5000")(staleBlob);
  await sleep(0);
  assert.notEqual(p.frame, staleBlob, "修改前的缓存结果不得占据分镜");
  assert.equal(p.frameStatus, "loading", "新取帧仍在进行，不被旧缓存打断");

  // 新键未命中 -> 实时提取源时间 6
  pending.get("sha256:AAA/t6000")(null);
  await h.env.drain();
  await editDone;
  await inflight;
  assert.equal(p.frameStatus, "ok");
  assert.equal(p.frame.__mark.time, 6);
});

test("偏移未实际变化时不得误杀在途取帧（无部分生效的轨道状态）", async () => {
  const { app, h } = makeApp();
  const tr = addTrack(app);
  const p = app.timeline.addPoint(2).point;

  const inflight = app.ensurePointFrame(p);
  app.commitOffset(tr.id, 0); // 与当前偏移相同：不应换代、不应重取
  await h.env.drain();
  await inflight;
  assert.equal(p.frameStatus, "ok", "无变化的提交不得让点卡在取帧中");
  assert.equal(p.frame.__mark.time, 2);

  // 偏移真的变化：点重解析、旧帧作废、按新源时间重取
  app.commitOffset(tr.id, 1.5);
  assert.equal(p.sourceTime, 0.5);
  assert.equal(p.frameStatus, "loading");
  await h.env.drain();
  await sleep(0);
  assert.equal(p.frameStatus, "ok");
  assert.equal(p.frame.__mark.time, 0.5);
});

test("取帧键携带摘要算法前缀（fcs32 回退不与 sha256 撞键）", async () => {
  const puts = [];
  const cache = nullCache({ put: async (k) => puts.push(k) });
  const { app, h } = makeApp({ cache });
  const tr = addTrack(app, { digest: { algo: "fcs32", hex: "abcd1234" } });
  const p = app.timeline.addPoint(2).point;
  const done = app.ensurePointFrame(p);
  await h.env.drain();
  await done;
  assert.equal(p.frameStatus, "ok");
  assert.deepEqual(puts, ["fcs32:abcd1234/t2000"]);
});

test("导出清单遵守当前剪辑参数（覆盖时长/源时间/编辑记录）", async () => {
  const { app } = makeApp();
  const tr = addTrack(app, { duration: 12 });
  app.timeline.setClipEdit(tr.id, { in: 2, out: 10, rate: 2, reverse: true });
  const p = app.timeline.addPoint(1).point; // 源 10 - 1*2 = 8
  const m = app.buildManifestNow();
  assert.equal(m.projectDuration, 4, "项目时长 = 保留区间 8s / 2x");
  assert.equal(m.tracks[0].coverage, 4);
  assert.deepEqual(m.tracks[0].edit, {
    in: 2,
    out: 10,
    rate: 2,
    reverse: true,
  });
  const mp = m.points.find((x) => x.id === p.id);
  assert.equal(mp.sourceTime, 8, "清单源时间按倒放映射");
  assert.equal(mp.frameKey, `sha256:AAA/t8000`);
});

test("失去覆盖的点不参与补帧与快照（剪短轨道后不留旧图）", async () => {
  const { app, h } = makeApp();
  const tr = addTrack(app);
  const p1 = app.timeline.addPoint(2).point;
  const p2 = app.timeline.addPoint(8).point;
  const first = app.refreshStaleFrames();
  await h.env.drain();
  await first;
  assert.equal(p2.frameStatus, "ok");
  const mediaBefore = h.created.length;

  // 剪短到 5s：p2 失去覆盖
  const editDone = app.commitClipEdit(tr.id, {
    in: 0,
    out: 5,
    rate: 1,
    reverse: false,
  });
  await h.env.drain();
  await editDone;

  assert.equal(p2.trackId, null);
  assert.equal(p2.frame, null, "失去覆盖的点不得保留旧图");
  assert.equal(
    h.created.length,
    mediaBefore,
    "失去覆盖的点不得再发起取帧",
  );
  assert.deepEqual(
    app.timeline.confirmedSnapshot().map((p) => p.id),
    [p1.id],
  );
});
