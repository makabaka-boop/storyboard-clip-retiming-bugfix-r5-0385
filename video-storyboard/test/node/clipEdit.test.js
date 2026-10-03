import test from "node:test";
import assert from "node:assert/strict";
import { Timeline, frameKeyFor } from "../../src/timeline.js";
import { validateEdit, coverage, sourceAt } from "../../src/clipEdit.js";
import { buildManifest } from "../../src/exports.js";

function track(tl, opts = {}) {
  return tl.addTrack({
    name: opts.name ?? `v${Math.random()}`,
    digest: opts.digest ?? `d${Math.random()}`,
    duration: opts.duration ?? 10,
    offset: opts.offset ?? 0,
    width: 320,
    height: 180,
  });
}

// ---------- validateEdit：整体校验，非法即抛 ----------

test("剪辑校验：缺省值与不剪辑等价，入出点归一化到毫秒", () => {
  const t = { duration: 10 };
  assert.deepEqual(validateEdit(t, {}), {
    in: 0,
    out: 10,
    rate: 1,
    reverse: false,
  });
  assert.equal(validateEdit(t, null), null);
  const e = validateEdit(t, {
    in: 1.0004,
    out: 5.0006,
    rate: 2,
    reverse: true,
  });
  assert.deepEqual(e, { in: 1, out: 5.001, rate: 2, reverse: true });
});

test("剪辑校验：非法速度/入出点整体拒绝", () => {
  const t = { duration: 10 };
  const bad = [
    { rate: 0 },
    { rate: -1 },
    { rate: Number.NaN },
    { rate: Infinity },
    { in: -0.5 },
    { in: 10 }, // 入点必须 < 素材时长
    { in: 6, out: 6 }, // 出点必须大于入点
    { in: 6, out: 5 },
    { out: 10.5 }, // 出点超出素材时长
    { out: Number.NaN },
    { in: 9.9999, out: 10, rate: 0.0001 }, // 覆盖不足 1ms
  ];
  for (const edit of bad) {
    assert.throws(
      () => validateEdit(t, edit),
      (err) => err.code === "BAD_EDIT",
      `应拒绝 ${JSON.stringify(edit)}`,
    );
  }
});

test("非法剪辑不会部分生效：track.edit 保持原值，点位与帧不受影响", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: "A" });
  tl.setClipEdit(a.id, { in: 1, out: 8, rate: 2, reverse: false });
  const before = tl.getTrack(a.id).edit;
  const p = tl.addPoint(2).point; // 覆盖内：源 1 + 2*2 = 5
  p.frame = new Blob(["f"]);
  p.frameStatus = "ok";
  const srcBefore = p.sourceTime;

  assert.throws(() => tl.setClipEdit(a.id, { in: 1, out: 99 }), (e) => e.code === "BAD_EDIT");
  assert.equal(tl.getTrack(a.id).edit, before, "旧剪辑原样保留");
  assert.equal(p.sourceTime, srcBefore, "点位源时间未被非法编辑扰动");
  assert.equal(p.frameStatus, "ok", "已就绪的帧不被非法编辑作废");

  assert.throws(() => tl.setClipEdit(a.id, { rate: -2 }), (e) => e.code === "BAD_EDIT");
  assert.equal(tl.getTrack(a.id).edit, before);
});

// ---------- coverage / sourceAt ----------

test("覆盖长度由保留源区间与倍速决定；反向不改变长度", () => {
  const t = { duration: 10, edit: null };
  assert.equal(coverage(t), 10);
  t.edit = validateEdit(t, { in: 2, out: 8, rate: 2 });
  assert.equal(coverage(t), 3); // (8-2)/2
  t.edit = validateEdit(t, { in: 2, out: 8, rate: 0.5 });
  assert.equal(coverage(t), 12);
  t.edit = validateEdit(t, { in: 2, out: 8, rate: 2, reverse: true });
  assert.equal(coverage(t), 3);
});

test("源时间映射：正向 in+elapsed*rate，反向 out-elapsed*rate，均钳制在保留区间", () => {
  const t = { duration: 10 };
  t.edit = validateEdit(t, { in: 2, out: 8, rate: 2 });
  assert.equal(sourceAt(t, 0), 2);
  assert.equal(sourceAt(t, 1.5), 5);
  assert.equal(sourceAt(t, 3), 8); // 覆盖末端 -> 出点
  assert.equal(sourceAt(t, 99), 8, "浮点越界钳到出点");

  t.edit = validateEdit(t, { in: 2, out: 8, rate: 2, reverse: true });
  assert.equal(sourceAt(t, 0), 8, "反向从出点开始");
  assert.equal(sourceAt(t, 1.5), 5);
  assert.equal(sourceAt(t, 3), 2, "反向末端到入点");
  assert.equal(sourceAt(t, 99), 2, "钳到入点");

  const plain = { duration: 10, edit: null };
  assert.equal(sourceAt(plain, 4), 4);
  assert.equal(sourceAt(plain, 99), 10);
});

// ---------- 点位归属：切口 / 重叠 / 空隙 / 范围末端 ----------

test("相邻剪辑的切点归后续覆盖片段", () => {
  const tl = new Timeline();
  const a = track(tl, { name: "a", duration: 5 });
  const b = track(tl, { name: "b", duration: 5, offset: 5 });
  assert.equal(tl.resolve(5).track.id, b.id, "切点 5s 归后一段");
  assert.equal(tl.resolve(5).sourceTime, 0);
  assert.equal(tl.resolve(4.999).track.id, a.id);
  assert.equal(tl.resolve(10).track.id, b.id, "范围末端归最后一段");
  assert.equal(tl.resolve(10).sourceTime, 5, "末端源时间钳到覆盖末端");
});

test("重叠仍取先插入轨道，但先插入轨道的切口归后续片段", () => {
  const tl = new Timeline();
  const a = track(tl, { name: "a", duration: 10 });
  const b = track(tl, { name: "b", duration: 6, offset: 8 });
  assert.equal(tl.resolve(9).track.id, a.id, "重叠区取先插入");
  assert.equal(tl.resolve(10).track.id, b.id, "a 的切口归 b");
  assert.equal(tl.resolve(10).sourceTime, 2);
  assert.equal(tl.resolve(14).track.id, b.id, "范围末端");
  assert.equal(tl.resolve(14.5), null, "超出所有覆盖为空隙");
});

test("范围末端可以加点，源时间钳在保留区间末端", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10 });
  tl.setClipEdit(a.id, { in: 2, out: 6, rate: 1 }); // 覆盖 [0,4)
  const res = tl.addPoint(4);
  assert.ok(res.ok);
  assert.equal(res.point.projectTime, 4);
  assert.equal(res.point.sourceTime, 6, "末端对应出点");
});

// ---------- 剪辑驱动的时间尺/点位/倒放 ----------

test("剪辑后项目总时长与点位源时间共同遵守剪辑参数", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: "A" });
  tl.setClipEdit(a.id, { in: 2, out: 8, rate: 2 }); // 项目覆盖 [0,3)
  assert.equal(tl.projectDuration(), 3);

  const p1 = tl.addPoint(0).point;
  assert.equal(p1.sourceTime, 2);
  const p2 = tl.addPoint(1.5).point;
  assert.equal(p2.sourceTime, 5);
  assert.equal(tl.resolve(3.5), null, "覆盖之外是空隙");
  // 均匀取点按剪辑后的覆盖长度分布
  tl.clearPoints();
  const r = tl.addPointsUniform(3);
  assert.ok(r.ok);
  assert.deepEqual(
    tl.points.map((p) => p.projectTime),
    [0.5, 1.5, 2.5],
  );
  assert.deepEqual(
    tl.points.map((p) => p.sourceTime),
    [3, 5, 7],
  );
});

test("倒放：项目时间正向推进，源时间从出点走向入点", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: "A" });
  tl.setClipEdit(a.id, { in: 1, out: 5, rate: 1, reverse: true }); // 覆盖 [0,4)
  const ts = [0, 1, 2, 3, 4];
  const srcs = ts.map((t) => tl.resolve(t).sourceTime);
  assert.deepEqual(srcs, [5, 4, 3, 2, 1], "项目时间递增 -> 源时间递减");
  // 分镜点仍按项目时间升序排列
  for (const t of ts) tl.addPoint(t);
  const pts = tl.confirmedSnapshot();
  assert.deepEqual(
    pts.map((p) => p.projectTime),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    pts.map((p) => p.sourceTime),
    [5, 4, 3, 2, 1],
  );
});

test("修改剪辑后点位重新解析：源时间变化的点立即作废旧帧", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: "A" });
  const p = tl.addPoint(2).point; // 源 2
  p.frame = new Blob(["old"]);
  p.frameStatus = "ok";
  p.frameKey = frameKeyFor("A", 2);

  tl.setClipEdit(a.id, { in: 1, out: 9, rate: 2 }); // 项目 2s -> 源 1+2*2=5
  assert.equal(p.sourceTime, 5);
  assert.equal(p.frame, null, "旧帧必须丢弃");
  assert.equal(p.frameStatus, "stale");
  assert.equal(p.frameKey, frameKeyFor("A", 5), "取帧键跟随新源时间");
});

// ---------- 失去覆盖的点：不保留旧图、不按旧源时间重取 ----------

test("剪短轨道后失去覆盖的点：旧帧与源时间一起清空，恢复覆盖后可重取", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: "A" });
  const p = tl.addPoint(8).point;
  p.frame = new Blob(["old"]);
  p.frameURL = "blob:old";
  p.frameStatus = "ok";

  tl.setClipEdit(a.id, { in: 0, out: 5, rate: 1 }); // 覆盖缩到 [0,5)
  assert.equal(p.frame, null, "失去覆盖的点不得保留旧图");
  assert.equal(p.frameURL, null);
  assert.equal(p.sourceTime, null, "旧源时间映射一并作废");
  assert.equal(p.frameKey, null);
  assert.equal(p.frameStatus, "idle");

  // 恢复覆盖：同一项目时间重新解析，等待上层重取
  tl.setClipEdit(a.id, { in: 0, out: 10, rate: 1 });
  assert.equal(p.sourceTime, 8);
  assert.equal(p.frameStatus, "idle", "帧已被丢弃，需重新提取");
  assert.equal(p.frame, null);
});

test("失去覆盖的点不会把旧源时间泄漏给导出清单", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: "A" });
  const p1 = tl.addPoint(2).point;
  const p2 = tl.addPoint(8).point;
  tl.setClipEdit(a.id, { in: 0, out: 5, rate: 1 }); // p2 失去覆盖

  const tracks = new Map(tl.tracks.map((t) => [t.id, { ...t }]));
  const m = buildManifest(tl.confirmedSnapshot(), tracks, null);
  assert.equal(m.projectDuration, 5, "清单项目总时长遵守剪辑");
  assert.equal(m.tracks[0].coverage, 5);
  assert.deepEqual(m.tracks[0].edit, { in: 0, out: 5, rate: 1, reverse: false });
  const mp1 = m.points.find((x) => x.id === p1.id);
  const mp2 = m.points.find((x) => x.id === p2.id);
  assert.equal(mp1.sourceTime, 2);
  assert.equal(mp1.covered, true);
  assert.equal(mp2.sourceTime, null, "失去覆盖的点导出 null 而非过期源时间");
  assert.equal(mp2.covered, false);
  assert.equal(mp2.frameReady, false);
});

// ---------- 替换为更短素材 ----------

test("替换为更短素材：失效剪辑整体重置，超范围点失去覆盖", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: "old" });
  tl.setClipEdit(a.id, { in: 1, out: 8, rate: 1 }); // 覆盖 [0,7)
  const p = tl.addPoint(6).point; // 源 7
  p.frame = new Blob(["f"]);
  p.frameStatus = "ok";

  tl.replaceTrack(a.id, { digest: "new", duration: 5 }); // out=8 超出新时长
  assert.equal(tl.getTrack(a.id).edit, null, "出点超出新时长 -> 剪辑整体重置");
  assert.equal(tl.projectDuration(), 5);
  assert.equal(p.sourceTime, null, "项目 6s 已失去覆盖");
  assert.equal(p.frame, null);
  assert.equal(p.frameStatus, "idle");

  // 仍然有效的剪辑在替换后保留
  const tl2 = new Timeline();
  const b = track(tl2, { duration: 10, digest: "old" });
  tl2.setClipEdit(b.id, { in: 1, out: 4, rate: 2 });
  tl2.replaceTrack(b.id, { digest: "new", duration: 6 });
  assert.deepEqual(tl2.getTrack(b.id).edit, {
    in: 1,
    out: 4,
    rate: 2,
    reverse: false,
  });
  assert.equal(tl2.projectDuration(), 1.5);
});

// ---------- 偏移/剪辑组合 ----------

test("剪辑与偏移共同决定覆盖区间；空隙吸附也遵守剪辑后的边界", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, offset: 4 });
  tl.setClipEdit(a.id, { in: 0, out: 10, rate: 2 }); // 项目覆盖 [4,9)
  assert.equal(tl.projectDuration(), 9);
  assert.equal(tl.resolve(3.999), null);
  assert.equal(tl.resolve(4).sourceTime, 0);
  assert.equal(tl.resolve(9).sourceTime, 10, "范围末端");
  const res = tl.addPoint(12); // 空隙 -> 吸附到最近的覆盖边界 9
  assert.ok(res.ok);
  assert.equal(res.point.projectTime, 9);
  assert.equal(res.point.sourceTime, 10);
});

test("编辑期间尚未完成的取帧不会提交：重解析使 loading 点换代", () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: "A" });
  const p = tl.addPoint(2).point;
  p.frameStatus = "loading"; // 模拟在途取帧（源时间 2）
  tl.setClipEdit(a.id, { in: 0, out: 10, rate: 4 }); // 项目 2s -> 源 8
  assert.equal(p.sourceTime, 8);
  assert.equal(p.frameStatus, "stale", "在途旧帧的提交条件（loading）被撤销");
  assert.equal(p.frame, null);
});
