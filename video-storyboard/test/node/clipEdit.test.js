import test from "node:test";
import assert from "node:assert/strict";
import { Timeline, frameKeyFor } from "../../src/timeline.js";
import { validateEdit, coverage, sourceAt } from "../../src/clipEdit.js";

function track(tl, opts = {}) {
  return tl.addTrack({
    name: opts.name ?? `v${Math.random()}`,
    digest: opts.digest ?? { algo: "sha256", hex: `d${Math.random()}` },
    duration: opts.duration ?? 10,
    offset: opts.offset ?? 0,
    width: 320,
    height: 180,
  });
}

// ---------- validateEdit：非法编辑整体拒绝，绝不部分生效 ----------

test("validateEdit：合法参数归一化，缺省为整段/1x/正放", () => {
  const t = { duration: 10 };
  assert.deepEqual(validateEdit(t, {}), {
    in: 0,
    out: 10,
    rate: 1,
    reverse: false,
  });
  assert.deepEqual(validateEdit(t, { in: 2, out: 8, rate: 2, reverse: true }), {
    in: 2,
    out: 8,
    rate: 2,
    reverse: true,
  });
});

test("validateEdit：无效入点/出点/倍速一律抛错", () => {
  const t = { duration: 10 };
  for (const bad of [
    { in: -1 },
    { in: 11 },
    { in: NaN },
    { out: 10.5 },
    { out: -2 },
    { in: 5, out: 5 }, // 空区间
    { in: 6, out: 4 }, // 出点早于入点
    { rate: 0 },
    { rate: -2 },
    { rate: NaN },
    { rate: Infinity },
  ]) {
    assert.throws(() => validateEdit(t, bad), `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test("setClipEdit：非法编辑抛错且轨道保持原状（无部分生效）", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 10 });
  tl.setClipEdit(tr.id, { in: 1, out: 5, rate: 2, reverse: false });
  const before = { ...tr.edit };
  assert.throws(() =>
    tl.setClipEdit(tr.id, { in: 1, out: 5, rate: 0, reverse: true }),
  );
  assert.deepEqual(tr.edit, before, "非法编辑不得改动已有剪辑");
  assert.equal(coverage(tr), 2); // (5-1)/2
});

// ---------- coverage / sourceAt：覆盖长度与源时间映射 ----------

test("coverage：覆盖长度 = 保留源区间 / 倍速，反向不改变长度", () => {
  const t = { duration: 10 };
  assert.equal(coverage(t), 10);
  t.edit = validateEdit(t, { in: 2, out: 8, rate: 2 });
  assert.equal(coverage(t), 3);
  t.edit = validateEdit(t, { in: 2, out: 8, rate: 0.5, reverse: true });
  assert.equal(coverage(t), 12);
});

test("sourceAt：正放、倍速、倒放的源时间映射", () => {
  const t = { duration: 10 };
  assert.equal(sourceAt(t, 3), 3); // 无剪辑
  t.edit = validateEdit(t, { in: 2, out: 8, rate: 2 });
  assert.equal(sourceAt(t, 0), 2);
  assert.equal(sourceAt(t, 1.5), 5);
  assert.equal(sourceAt(t, 3), 8); // 覆盖末端 -> 出点
  t.edit = validateEdit(t, { in: 2, out: 8, rate: 2, reverse: true });
  assert.equal(sourceAt(t, 0), 8, "倒放从出点开始");
  assert.equal(sourceAt(t, 1.5), 5);
  assert.equal(sourceAt(t, 3), 2, "倒放到入点结束");
  // 钳制：越界输入不会得到素材范围外的源时间
  assert.equal(sourceAt(t, 99), 2);
  assert.equal(sourceAt(t, -1), 8);
});

// ---------- 时间轴集成：剪辑参数驱动点位归属 ----------

test("剪辑后项目总时长与点位源时间遵守剪辑参数", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 10 });
  tl.setClipEdit(tr.id, { in: 2, out: 8, rate: 2, reverse: false });
  assert.equal(tl.projectDuration(), 3, "项目时长按剪辑后覆盖计算");
  const r = tl.resolve(1);
  assert.equal(r.track.id, tr.id);
  assert.ok(Math.abs(r.sourceTime - 4) < 1e-9); // 2 + 1*2
  assert.equal(tl.resolve(3), null, "覆盖末端（半开区间）之外不归属本轨");
});

test("倒放：点位取到正确的源时间（项目时间仍正向）", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 10 });
  tl.setClipEdit(tr.id, { in: 2, out: 8, rate: 1, reverse: true });
  assert.equal(tl.projectDuration(), 6);
  const p0 = tl.addPoint(0).point;
  assert.equal(p0.sourceTime, 8, "倒放首帧 = 出点");
  const p1 = tl.addPoint(3).point;
  assert.equal(p1.sourceTime, 5); // 8 - 3
  const p2 = tl.addPoint(5.5).point;
  assert.equal(p2.sourceTime, 2.5);
  // 快照按项目时间升序，与倒放无关
  assert.deepEqual(
    tl.confirmedSnapshot().map((p) => p.projectTime),
    [0, 3, 5.5],
  );
});

test("相邻剪辑的切点归后续覆盖片段", () => {
  const tl = new Timeline();
  track(tl, { name: "a", duration: 5 });
  const b = track(tl, { name: "b", duration: 5, offset: 5 });
  const r = tl.resolve(5);
  assert.equal(r.track.id, b.id, "切点 5s 属于后一段");
  assert.equal(r.sourceTime, 0);
  // 前一段的最后一帧在 5s 之前
  const p = tl.addPoint(5).point;
  assert.equal(p.trackId, b.id);
});

test("范围末端：项目末尾的点退到最后一毫秒，不越界", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 5 });
  const res = tl.addPoint(5); // 恰好在覆盖末端
  assert.ok(res.ok);
  assert.equal(res.point.projectTime, 4.999);
  assert.equal(res.point.trackId, tr.id);
  // 超出末端也一样吸附回最后一帧
  const res2 = tl.addPoint(9.9);
  assert.equal(res2.ok, false, "同一毫秒桶去重");
  const res3 = tl.addPoint(4.5);
  assert.ok(res3.ok);
  assert.equal(res3.point.projectTime, 4.5);
});

test("剪短轨道（出点前移）后，失去覆盖的分镜点脱离快照且旧帧作废", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 10 });
  const p1 = tl.addPoint(2).point;
  const p2 = tl.addPoint(8).point;
  p1.frame = new Blob(["f1"]);
  p1.frameStatus = "ok";
  p2.frame = new Blob(["f2"]);
  p2.frameStatus = "ok";

  tl.setClipEdit(tr.id, { in: 0, out: 5, rate: 1, reverse: false });
  assert.equal(tl.projectDuration(), 5);

  assert.equal(p1.frameStatus, "ok", "仍被覆盖的点保留帧");
  assert.ok(p1.frame, "p1 帧不受影响");

  assert.equal(p2.trackId, null, "失去覆盖的点与轨道解绑");
  assert.equal(p2.sourceTime, null);
  assert.equal(p2.frame, null, "旧图必须丢弃");
  assert.equal(p2.frameStatus, "idle");
  assert.deepEqual(
    tl.confirmedSnapshot().map((p) => p.id),
    [p1.id],
    "失去覆盖的点不进入播放/导出快照",
  );

  // 重新放宽出点：点复活并重新解析，但帧必须重取（stale）
  tl.setClipEdit(tr.id, { in: 0, out: 10, rate: 1, reverse: false });
  assert.equal(p2.trackId, tr.id);
  assert.equal(p2.sourceTime, 8);
  assert.equal(p2.frameStatus, "stale");
  assert.equal(p2.frame, null);
  assert.equal(tl.confirmedSnapshot().length, 2);
});

test("倍速改变后源时间重映射，旧帧作废；取帧键随源时间更新", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 12, digest: { algo: "sha256", hex: "H" } });
  const p = tl.addPoint(3).point; // 源时间 3
  p.frame = new Blob(["x"]);
  p.frameStatus = "ok";
  const gen0 = p.frameGen;

  tl.setClipEdit(tr.id, { in: 0, out: 12, rate: 2, reverse: false });
  assert.equal(p.sourceTime, 6, "3s 项目时间 -> 源 6s（2x）");
  assert.equal(p.frame, null);
  assert.equal(p.frameStatus, "stale");
  assert.ok(p.frameGen > gen0, "作废推进帧代际");
  assert.equal(p.frameKey, frameKeyFor({ algo: "sha256", hex: "H" }, 6));

  // 再开倒放：同一项目时间映射到出点侧
  tl.setClipEdit(tr.id, { in: 0, out: 12, rate: 2, reverse: true });
  assert.equal(p.sourceTime, 6, "12 - 3*2 = 6");
  assert.equal(p.frameStatus, "stale");
});

test("替换为更短素材：越界点脱离覆盖，剪辑区间收缩进新时长", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 10 });
  tl.setClipEdit(tr.id, { in: 2, out: 10, rate: 1, reverse: false });
  const p1 = tl.addPoint(1).point; // 源 3
  const p2 = tl.addPoint(7).point; // 源 9
  p1.frame = new Blob(["a"]);
  p1.frameStatus = "ok";

  tl.replaceTrack(tr.id, { digest: { algo: "sha256", hex: "N" }, duration: 6 });
  assert.deepEqual(
    tr.edit,
    { in: 2, out: 6, rate: 1, reverse: false },
    "出点收缩到新素材时长",
  );
  assert.equal(tl.projectDuration(), 4);
  assert.equal(p1.sourceTime, 3);
  assert.equal(p1.frame, null, "换文件后同源时间的帧也必须重取");
  assert.equal(p1.frameStatus, "stale");
  assert.equal(p2.trackId, null, "超出新素材的点脱离覆盖");
  assert.equal(tl.confirmedSnapshot().length, 1);
});

test("替换素材容纳不下当前剪辑区间时整体拒绝，轨道状态不变", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 10 });
  tl.setClipEdit(tr.id, { in: 6, out: 10, rate: 1, reverse: false });
  const editBefore = { ...tr.edit };
  assert.throws(
    () => tl.replaceTrack(tr.id, { digest: { algo: "sha256", hex: "N" }, duration: 5 }),
    /剪辑区间|入点|出点/,
  );
  assert.equal(tr.duration, 10, "拒绝后时长不变");
  assert.deepEqual(tr.edit, editBefore, "拒绝后剪辑不变");
});

test("轨道重叠与空隙：剪辑后的覆盖参与解析与吸附", () => {
  const tl = new Timeline();
  const a = track(tl, { name: "a", duration: 10 }); // 覆盖 [0,10)
  const b = track(tl, { name: "b", duration: 10, offset: 4 });
  tl.setClipEdit(b.id, { in: 0, out: 10, rate: 2, reverse: false }); // b 覆盖 [4,9)
  assert.equal(tl.projectDuration(), 10);
  // 重叠区取先插入的 a
  assert.equal(tl.resolve(5).track.id, a.id);
  // b 在 9 处结束，a 仍覆盖 -> 9 属于 a
  assert.equal(tl.resolve(9).track.id, a.id);
  // 删掉 a 后，9~10 成为空隙，加点吸附到 b 的末端最后一毫秒
  tl.removeTrack(a.id);
  assert.equal(tl.projectDuration(), 9);
  const res = tl.addPoint(9.5);
  assert.ok(res.ok);
  assert.equal(res.point.projectTime, 8.999);
  assert.equal(res.point.trackId, b.id);
  assert.equal(res.point.sourceTime, 9.998); // 0 + 8.999*2
});

test("取帧键包含摘要算法前缀：sha256 与 fcs32 不撞键", () => {
  assert.equal(frameKeyFor("ABC", 1), "sha256:ABC/t1000"); // 裸字符串按 sha256
  assert.equal(
    frameKeyFor({ algo: "fcs32", hex: "ABC" }, 1),
    "fcs32:ABC/t1000",
  );
  assert.notEqual(
    frameKeyFor({ algo: "sha256", hex: "ABC" }, 1),
    frameKeyFor({ algo: "fcs32", hex: "ABC" }, 1),
  );
});

test("重解析后源时间稳定归一化到毫秒（键与导出源时间确定）", () => {
  const tl = new Timeline();
  const tr = track(tl, { duration: 10, digest: { algo: "sha256", hex: "K" } });
  tl.setClipEdit(tr.id, { in: 0, out: 10, rate: 3, reverse: false });
  const p = tl.addPoint(1).point; // 源 3
  assert.equal(p.sourceTime, 3);
  // 反复重解析（例如无关轨道变动）不得让源时间漂移出毫秒桶
  tl.setOffset(tr.id, 0.5);
  tl.setOffset(tr.id, 0);
  assert.equal(p.sourceTime, 3);
  assert.equal(p.frameKey, "sha256:K/t3000");
});
