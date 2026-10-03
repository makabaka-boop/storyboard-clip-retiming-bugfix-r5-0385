// 应用主控：导入/偏移/取帧调度/播放/导出。
// 不变量：
//  1) 点击播放、PNG 接触表、JSON 清单三者只能消费同一次
//     confirmedSnapshot() 的返回值（freezeSnapshot）；
//  2) 取帧的竞争安全全部由 FrameExtractor 保证（令牌+换代）；
//  3) 缓存失败只影响“帧”，Timeline 与分镜清单永远可用；
//  4) objectURL 失效时统一经 releasePointFrame 回收。

import { Timeline, frameKeyFor } from "./timeline.js";
import { FrameExtractor } from "./extractor.js";
import { FrameCache } from "./cache.js";
import { digestFile } from "./hash.js";
import { createRealMedia, createRealCanvas, probeVideo } from "./media-dom.js";
import { buildContactSheet, buildManifest, downloadBlob } from "./exports.js";

const OFFSET_DEBOUNCE_MS = 150;

export class App {
  constructor({ extractor, cache } = {}) {
    this.timeline = new Timeline();
    this.extractor =
      extractor ??
      new FrameExtractor({
        createMedia: createRealMedia,
        createCanvas: createRealCanvas,
        concurrency: 3,
      });
    this.cache = cache ?? new FrameCache({ maxBytes: 200 * 1024 * 1024 });
    /** trackId -> {url,file,digest:{algo,hex}} */
    this.files = new Map();
    this.playFile = null; // 当前播放器载入的 {trackId, url}
    this.onDirty = null; // 数据变化后 UI 重绘回调
    this._offsetTimers = new Map();
  }

  emit() {
    this.onDirty?.();
  }

  tracks() {
    return this.timeline.tracks;
  }
  points() {
    return this.timeline.points;
  }

  // ---------- 导入 ----------

  async importFiles(fileList) {
    const files = [...fileList].filter(
      (f) =>
        f.type.startsWith("video/") ||
        /\.(webm|mp4|mov|m4v|ogv|mkv)$/i.test(f.name),
    );
    const errors = [];
    for (const file of files) {
      try {
        // eslint-disable-next no-await-in-loop
        await this._addFile(file);
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`);
      }
    }
    this.emit();
    return errors;
  }

  async _addFile(file) {
    const { algo, hex, bytes } = await digestFile(file);
    const meta = await probeVideo(file);
    const track = this.timeline.addTrack({
      file,
      name: file.name,
      digest: { algo, hex },
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
    });
    const url = URL.createObjectURL(file);
    this.files.set(track.id, { url, file, bytes, digest: { algo, hex } });
    return track;
  }

  /** 替换某轨的源文件：在途帧立即换代失效，旧 URL 回收 */
  async replaceFile(trackId, file) {
    const entry = this.files.get(trackId);
    const { algo, hex, bytes } = await digestFile(file);
    const meta = await probeVideo(file);
    // 先换代：任何属于旧文件的在途取帧都不允许提交
    this.extractor.bumpTrack(trackId);
    if (entry) URL.revokeObjectURL(entry.url);
    const url = URL.createObjectURL(file);
    this.files.set(trackId, { url, file, bytes, digest: { algo, hex } });
    this.timeline.replaceTrack(trackId, {
      file,
      name: file.name,
      digest: { algo, hex },
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
    });
    if (this.playFile?.trackId === trackId) this.playFile = { trackId, url };
    this.emit();
    await this.refreshStaleFrames();
  }

  removeTrack(trackId) {
    const entry = this.files.get(trackId);
    this.extractor.bumpTrack(trackId);
    if (entry) URL.revokeObjectURL(entry.url);
    for (const p of this.timeline.points) {
      if (p.trackId === trackId && p.frameURL) URL.revokeObjectURL(p.frameURL);
    }
    this.files.delete(trackId);
    if (this.playFile?.trackId === trackId) this.playFile = null;
    this.timeline.removeTrack(trackId);
    this.emit();
  }

  // ---------- 偏移 ----------

  /** 拖动/输入时实时更新（内部做防抖合并重取帧） */
  requestOffsetChange(trackId, offset) {
    const t = this._offsetTimers.get(trackId);
    if (t) clearTimeout(t);
    try {
      this.timeline.setOffset(trackId, Number(offset) || 0);
      this.emit();
    } catch {
      /* 中间态非法值忽略 */
    }
    this._offsetTimers.set(
      trackId,
      setTimeout(() => {
        this._offsetTimers.delete(trackId);
        this.extractor.bumpTrack(trackId);
        this.refreshStaleFrames();
      }, OFFSET_DEBOUNCE_MS),
    );
  }

  async commitClipEdit(trackId, edit) {
    this.timeline.setClipEdit(trackId, edit);
    this.emit();
    await this.refreshStaleFrames();
  }

  commitOffset(trackId, offset) {
    const t = this._offsetTimers.get(trackId);
    if (t) {
      clearTimeout(t);
      this._offsetTimers.delete(trackId);
    }
    this.timeline.setOffset(trackId, Number(offset) || 0);
    this.extractor.bumpTrack(trackId);
    this.emit();
    this.refreshStaleFrames();
  }

  // ---------- 分镜点 ----------

  addPointAtProjectTime(t) {
    const res = this.timeline.addPoint(t);
    this.emit();
    if (res.ok) this.ensurePointFrame(res.point);
    return res;
  }

  addUniform(n) {
    const res = this.timeline.addPointsUniform(n);
    this.emit();
    if (res.ok) this.refreshStaleFrames();
    return res;
  }

  removePoint(id) {
    const p = this.timeline.points.find((x) => x.id === id);
    if (p) {
      this.extractor.cancelPoint(id);
      if (p.frameURL) URL.revokeObjectURL(p.frameURL);
    }
    this.timeline.removePoint(id);
    this.emit();
  }

  clearPoints() {
    this.extractor.cancelAll();
    for (const p of this.timeline.points)
      if (p.frameURL) URL.revokeObjectURL(p.frameURL);
    this.timeline.clearPoints();
    this.emit();
  }

  // ---------- 取帧 ----------

  async ensurePointFrame(point) {
    // 失去覆盖的点（sourceTime 已被时间轴清空）不取帧：
    // 任何旧源时间都不再对应该点，取回的帧必然是过期画面。
    if (point.sourceTime == null) return;
    const track = this.timeline.getTrack(point.trackId);
    const entry = this.files.get(point.trackId);
    if (!track || !entry) return;

    // 取帧代次：同一点并发/交错的多次取帧，只有最新一次允许提交。
    // 否则“编辑前的缓存结果晚到”会在新一次调用把状态重置为 loading
    // 之后通过校验，让旧源时间的帧覆盖新映射。
    const fetchId = (point._fetchId = (point._fetchId ?? 0) + 1);
    const sourceTime = point.sourceTime; // 本次调用锁定的源时间
    point.frameKey = frameKeyFor(entry.digest.hex, sourceTime);
    point.frameStatus = "loading";
    this.emit();

    // 1) 先查本地缓存：内容相同（摘要一致）+ 同一源时间才命中
    try {
      const cached = await this.cache.get(point.frameKey);
      if (cached) {
        if (!this._isCurrentFetch(point, fetchId, sourceTime)) return;
        this._adoptFrame(point, cached, true);
        return;
      }
    } catch {
      /* 缓存读取失败 -> 直接走提取，绝不影响清单 */
    }

    // 2) 实时提取（竞争安全由 extractor 保证）
    const res = await this.extractor.capture(point.id, {
      trackId: point.trackId,
      url: entry.url,
      sourceTime,
    });

    if (
      res.status === "stale" ||
      !this._isCurrentFetch(point, fetchId, sourceTime)
    )
      return;
    if (res.status === "error") {
      point.frameStatus = "error";
      this.emit();
      return;
    }
    this._adoptFrame(point, res.blob, false);

    // 3) 回填缓存；配额失败内部已吞掉
    this.cache.put(point.frameKey, res.blob).catch(() => {});
  }

  /**
   * 本次取帧调用是否仍是该点的最新一次：
   * 点存活、代次未被淘汰、状态仍为 loading 且源时间未被重解析改变。
   */
  _isCurrentFetch(point, fetchId, sourceTime) {
    const live = this.timeline.points.find((p) => p.id === point.id);
    return (
      live === point &&
      point._fetchId === fetchId &&
      point.frameStatus === "loading" &&
      point.sourceTime === sourceTime
    );
  }

  _adoptFrame(point, blob, fromCache) {
    if (point.frameURL) URL.revokeObjectURL(point.frameURL);
    point.frame = blob;
    point.frameURL = URL.createObjectURL(blob);
    point.frameFromCache = fromCache;
    point.frameStatus = "ok";
    this.emit();
  }

  /** 为所有 stale/idle/error 且仍被覆盖的点补帧（并发受控于 extractor） */
  refreshStaleFrames() {
    const need = this.timeline
      .confirmedSnapshot()
      .filter(
        (p) =>
          p.sourceTime != null &&
          p.frameStatus !== "ok" &&
          p.frameStatus !== "loading",
      );
    return Promise.all(need.map((p) => this.ensurePointFrame(p)));
  }

  // ---------- 播放 ----------

  /** 点击分镜定位播放：返回播放器需要的 {url, projectTime, sourceTime} */
  locatePlayback(point) {
    const snap = this.timeline.confirmedSnapshot();
    const p = snap.find((x) => x.id === point.id) ?? point;
    if (p.sourceTime == null) return null; // 当前不在任何覆盖区间内
    const entry = this.files.get(p.trackId);
    if (!entry) return null;
    this.playFile = { trackId: p.trackId, url: entry.url };
    return {
      url: entry.url,
      projectTime: p.projectTime,
      sourceTime: p.sourceTime,
      point: p,
    };
  }

  // ---------- 导出（三者同一组已确认时间点） ----------

  /**
   * 冻结当前已确认分镜点：PNG 与 JSON 共用这次快照与同一 tracks 视图。
   * “冻结”的是成员集合与顺序（拷贝数组）；点对象仍引用实时实例，
   * 导出期间新完成的帧可以被接触表读到，但增/删/移动分镜点
   * 不会改变本次导出的数组——点击播放也必须传入同一快照中的点。
   */
  freezeSnapshot() {
    const snapshot = this.timeline.confirmedSnapshot();
    const tracks = new Map(this.timeline.tracks.map((t) => [t.id, { ...t }]));
    return { snapshot, tracks };
  }

  async exportContactSheet(opts) {
    const { snapshot, tracks } = this.freezeSnapshot();
    const sheet = await buildContactSheet(snapshot, tracks, opts);
    const manifest = buildManifest(snapshot, tracks, sheet);
    return { sheet, manifest, count: snapshot.length };
  }

  buildManifestNow() {
    const { snapshot, tracks } = this.freezeSnapshot();
    return buildManifest(snapshot, tracks, null);
  }

  /** 一键：先确保所有点都已尝试取帧，再用同一冻结快照产出 PNG+JSON */
  async exportAll(opts = {}) {
    await this.refreshStaleFrames();
    const { snapshot, tracks } = this.freezeSnapshot();
    const sheet = await buildContactSheet(snapshot, tracks, opts);
    const manifest = buildManifest(snapshot, tracks, sheet);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBlob(sheet.blob, `contact-sheet-${stamp}.png`);
    downloadBlob(
      new Blob([JSON.stringify(manifest, null, 2)], {
        type: "application/json",
      }),
      `storyboard-${stamp}.json`,
    );
    return { count: snapshot.length };
  }

  async cacheUsage() {
    return this.cache.usage();
  }

  async clearCache() {
    await this.cache.clear();
  }
}
