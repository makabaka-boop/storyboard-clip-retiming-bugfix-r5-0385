// 应用主控：导入/偏移/剪辑/取帧调度/播放/导出。
// 不变量：
//  1) 点击播放、PNG 接触表、JSON 清单三者只能消费同一次
//     confirmedSnapshot() 的返回值（freezeSnapshot）；
//  2) 取帧的竞争安全由 FrameExtractor（令牌+换代）与分镜点 frameGen
//     双重保证：编辑/替换/取消后，在途帧与旧缓存回读都不得提交；
//  3) 缓存失败只影响“帧”，Timeline 与分镜清单永远可用；
//  4) objectURL 在帧被作废/替换/移除时统一回收（onPointInvalidate 钩子）。

import { Timeline, frameKeyFor } from "./timeline.js";
import { FrameExtractor } from "./extractor.js";
import { FrameCache } from "./cache.js";
import { digestFile } from "./hash.js";
import { createRealMedia, createRealCanvas, probeVideo } from "./media-dom.js";
import { buildContactSheet, buildManifest, downloadBlob } from "./exports.js";

const OFFSET_DEBOUNCE_MS = 150;

export class App {
  constructor({ extractor, cache } = {}) {
    // 分镜点帧被时间轴作废（剪辑/偏移/替换/失去覆盖）时回收其 objectURL
    this.timeline = new Timeline({
      onPointInvalidate: (p) => {
        if (p.frameURL) URL.revokeObjectURL(p.frameURL);
      },
    });
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

  /** 替换某轨的源文件：先校验并落数据，再换代在途帧、换 URL——失败则整体不变 */
  async replaceFile(trackId, file) {
    const entry = this.files.get(trackId);
    const { algo, hex, bytes } = await digestFile(file);
    const meta = await probeVideo(file);
    // 先改时间轴：时长非法或已有剪辑区间放不进新素材时在这里整体抛错，
    // 此刻文件映射、objectURL、在途任务都还没动，绝不留下部分生效状态。
    this.timeline.replaceTrack(trackId, {
      file,
      name: file.name,
      digest: { algo, hex },
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
    });
    // 数据已生效：任何属于旧文件的在途取帧都不允许提交，旧 URL 回收
    this.extractor.bumpTrack(trackId);
    if (entry) URL.revokeObjectURL(entry.url);
    const url = URL.createObjectURL(file);
    this.files.set(trackId, { url, file, bytes, digest: { algo, hex } });
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
    // 重新解析后落到其他轨道的点已被标记 stale，立即补帧
    this.refreshStaleFrames();
  }

  // ---------- 偏移 ----------

  /** 拖动/输入时实时更新（内部做防抖合并重取帧） */
  requestOffsetChange(trackId, offset) {
    const rec = this._offsetTimers.get(trackId) ?? { timer: null, dirty: false };
    if (rec.timer) clearTimeout(rec.timer);
    try {
      if (this.timeline.setOffset(trackId, Number(offset) || 0)) {
        rec.dirty = true;
      }
      this.emit();
    } catch {
      /* 中间态非法值忽略 */
    }
    rec.timer = setTimeout(() => {
      this._offsetTimers.delete(trackId);
      // 只有偏移真的变化过才换代在途取帧：无变化的换代会误杀
      // 仍在有效源时间上的取帧任务，使分镜点卡在“取帧中”
      if (rec.dirty) {
        this.extractor.bumpTrack(trackId);
        this.refreshStaleFrames();
      }
    }, OFFSET_DEBOUNCE_MS);
    this._offsetTimers.set(trackId, rec);
  }

  /**
   * 应用剪辑参数。非法编辑在 timeline 层整体抛错（轨道状态不变）；
   * 合法编辑只使“解析结果变化”的点作废（frameGen 推进），
   * 解析未变化的点其“在途取帧”仍然有效——因此这里刻意不做
   * extractor.bumpTrack，避免误杀有效任务造成半吊子状态。
   */
  async commitClipEdit(trackId, edit) {
    this.timeline.setClipEdit(trackId, edit);
    this.emit();
    await this.refreshStaleFrames();
  }

  commitOffset(trackId, offset) {
    const rec = this._offsetTimers.get(trackId);
    if (rec) {
      if (rec.timer) clearTimeout(rec.timer);
      this._offsetTimers.delete(trackId);
    }
    if (this.timeline.setOffset(trackId, Number(offset) || 0)) {
      this.extractor.bumpTrack(trackId);
    }
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
    const track = this.timeline.getTrack(point.trackId);
    const entry = this.files.get(point.trackId);
    if (!track || !entry) return;

    // 快照本次取帧的代际/键/源时间：编辑一旦发生，frameGen 推进，
    // 此后无论缓存回读还是实时提取多晚返回，都不允许把旧帧提交进新分镜。
    const gen = point.frameGen ?? 0;
    const key = frameKeyFor(entry.digest, point.sourceTime);
    const sourceTime = point.sourceTime;
    point.frameKey = key;
    point.frameStatus = "loading";
    this.emit();

    // 1) 先查本地缓存：内容相同（摘要一致）+ 同一源时间才命中
    try {
      const cached = await this.cache.get(key);
      if (cached) {
        if (this._isCurrentPoint(point, gen)) this._adoptFrame(point, cached, true);
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

    if (res.status === "stale" || !this._isCurrentPoint(point, gen)) return;
    if (res.status === "error") {
      point.frameStatus = "error";
      this.emit();
      return;
    }
    this._adoptFrame(point, res.blob, false);

    // 3) 回填缓存；配额失败内部已吞掉
    this.cache.put(key, res.blob).catch(() => {});
  }

  /** 点仍存活、仍处于本次取帧、且期间没有任何编辑推进过帧代际 */
  _isCurrentPoint(point, gen) {
    const live = this.timeline.points.find((p) => p.id === point.id);
    return (
      live === point &&
      live.frameStatus === "loading" &&
      (live.frameGen ?? 0) === gen
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

  /** 为所有 stale/idle/error 且当前轨道有效的点补帧（并发受控于 extractor） */
  refreshStaleFrames() {
    const need = this.timeline
      .confirmedSnapshot()
      .filter((p) => p.frameStatus !== "ok" && p.frameStatus !== "loading");
    return Promise.all(need.map((p) => this.ensurePointFrame(p)));
  }

  // ---------- 播放 ----------

  /** 点击分镜定位播放：返回播放器需要的 {url, projectTime, sourceTime} */
  locatePlayback(point) {
    const snap = this.timeline.confirmedSnapshot();
    const p = snap.find((x) => x.id === point.id) ?? point;
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
