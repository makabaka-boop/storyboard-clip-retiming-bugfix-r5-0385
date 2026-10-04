// 纯逻辑：多轨统一时间轴 + 分镜点。
// 所有时间单位均为秒；分镜点以“项目时间 projectTime”为准，
// 播放/接触表/清单都从同一份有序快照取点（见 confirmedSnapshot）。

import { validateEdit, coverage, sourceAt } from "./clipEdit.js";
export const MAX_POINTS = 30;
const EPS = 1e-6;

let pidSeq = 0;
export function createPointId() {
  pidSeq += 1;
  return `pt_${Date.now().toString(36)}_${pidSeq}`;
}

let tidSeq = 0;
export function createTrackId() {
  tidSeq += 1;
  return `tr_${Date.now().toString(36)}_${tidSeq}`;
}

export class TimelineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Timeline {
  /**
   * @param opts.onPointInvalidate 分镜点帧被作废前回调（用于回收 objectURL 等
   *   外部资源）；纯逻辑层本身不持有也不释放任何 URL。
   */
  constructor({ onPointInvalidate } = {}) {
    /** @type {Track[]} 插入顺序即重叠时的优先级顺序 */
    this.tracks = [];
    /** @type {Point[]} 始终按 projectTime 升序 */
    this.points = [];
    this._onPointInvalidate = onPointInvalidate ?? null;
  }

  addTrack({
    id = createTrackId(),
    file,
    name,
    digest,
    duration,
    width,
    height,
    offset = 0,
  }) {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new TimelineError("BAD_DURATION", `无效的视频时长: ${duration}`);
    }
    const track = {
      id,
      file: file ?? null,
      name: name ?? "未命名",
      digest: digest ?? null,
      duration,
      width: width ?? 0,
      height: height ?? 0,
      offset: Number(offset) || 0,
    };
    this.tracks.push(track);
    this._recomputePoints();
    return track;
  }

  replaceTrack(id, patch) {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) throw new TimelineError("NO_TRACK", `轨道不存在: ${id}`);
    const duration = patch.duration ?? track.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new TimelineError("BAD_DURATION", "替换文件的时长无效");
    }
    // 替换为更短素材时，已有剪辑区间必须先收缩进新时长；
    // 容纳不下则整体拒绝——在任何字段被修改之前抛错，绝不部分生效。
    let edit = track.edit ?? null;
    if (edit) {
      edit = validateEdit(
        { duration },
        {
          ...edit,
          in: Math.min(edit.in, duration),
          out: Math.min(edit.out, duration),
        },
      );
    }
    Object.assign(track, {
      file: patch.file ?? track.file,
      name: patch.name ?? track.name,
      digest: patch.digest ?? track.digest,
      duration,
      width: patch.width ?? track.width,
      height: patch.height ?? track.height,
      ...(edit ? { edit } : {}),
    });
    // 替换文件后，即使源时间恰好相同，该轨所有已取帧也必须作废重取
    //（旧文件的内容不得占据新分镜）。
    for (const p of this.points) {
      if (p.trackId === id) this._invalidate(p, "stale");
    }
    this._recomputePoints();
    return track;
  }

  setClipEdit(id, edit) {
    const track = this.getTrack(id);
    if (!track) throw new TimelineError("NO_TRACK", "轨道不存在");
    track.edit = validateEdit(track, edit);
    this._recomputePoints();
  }

  /**
   * 修改轨道偏移。返回被修改的轨道；偏移量实际未变化时返回 null
   * （调用方据此判断是否需要作废旧取帧，避免无变化时误杀在途任务）。
   */
  setOffset(id, offset) {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) throw new TimelineError("NO_TRACK", `轨道不存在: ${id}`);
    offset = Number(offset);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new TimelineError("BAD_OFFSET", `无效偏移: ${offset}`);
    }
    if (Math.abs(track.offset - offset) < EPS) return null;
    track.offset = offset;
    this._recomputePoints();
    return track;
  }

  removeTrack(id) {
    const i = this.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tracks.splice(i, 1);
    // 被删轨道的分镜点无意义，直接移除（释放配额），
    // 其余点重新解析（可能因覆盖关系换到别的轨道）。
    this.points = this.points.filter((p) => p.trackId !== id);
    this._recomputePoints();
  }

  getTrack(id) {
    return this.tracks.find((t) => t.id === id) ?? null;
  }

  /** 项目总时长：所有轨道覆盖范围的右端点 */
  projectDuration() {
    return this.tracks.reduce((m, t) => Math.max(m, t.offset + coverage(t)), 0);
  }

  /**
   * 项目时间 -> {track, sourceTime}；落在空隙返回 null。
   * 每条轨道的覆盖区间是半开区间 [offset, offset+coverage)：
   * 两段相邻剪辑的切点归“后续覆盖片段”（前一段的末端没有可显示帧，
   * 切点时刻的画面属于后一段）；多轨重叠时取插入顺序最早的轨道。
   * 源时间由当前剪辑参数（入点/出点/倍速/反向）决定。
   */
  resolve(projectTime) {
    for (const track of this.tracks) {
      const s = projectTime - track.offset;
      if (s >= -EPS && s < coverage(track)) {
        return {
          track,
          sourceTime: sourceAt(
            track,
            Math.min(Math.max(s, 0), coverage(track)),
          ),
        };
      }
    }
    return null;
  }

  /** 空隙时间吸附到最近的被覆盖时间；完全没有轨道时返回 null */
  nearestCovered(projectTime) {
    let best = null;
    for (const track of this.tracks) {
      const start = track.offset;
      const end = track.offset + coverage(track);
      const c = Math.min(Math.max(projectTime, start), end);
      if (
        best === null ||
        Math.abs(c - projectTime) < Math.abs(best - projectTime)
      )
        best = c;
    }
    return best;
  }

  /**
   * 新增分镜点。projectTime 落在空隙会自动吸附到最近的被覆盖时间；
   * 吸附/归一化后落在某段覆盖的末端边界（半开区间不含终点）时，
   * 退到该段最后一毫秒。同一轨道、同一毫秒桶的点视为重复。
   * 返回 {ok, point?, error?}
   */
  addPoint(projectTime) {
    if (this.points.length >= MAX_POINTS) {
      return { ok: false, error: `分镜点数量上限 ${MAX_POINTS} 个` };
    }
    if (!Number.isFinite(projectTime) || projectTime < 0) {
      return { ok: false, error: `无效的时间: ${projectTime}` };
    }
    // 存储时归一化到毫秒桶，保证 0.1004/0.1006 这类浮点抖动与显示值一致
    let t = Math.round(projectTime * 1000) / 1000;
    let r = this.resolve(t);
    if (!r) {
      const snapped = this.nearestCovered(t);
      if (snapped === null) return { ok: false, error: "尚未导入任何视频" };
      t = Math.round(snapped * 1000) / 1000;
      r = this.resolve(t);
      // 末端边界：半开区间不包含终点，逐毫秒退到被覆盖的最后一帧
      for (let i = 0; !r && i < 4 && t > 0; i += 1) {
        t = Math.round((t - 0.001) * 1000) / 1000;
        r = this.resolve(t);
      }
      if (!r) return { ok: false, error: "该时刻不在任何轨道覆盖范围内" };
    }
    const ms = Math.round(t * 1000);
    if (
      this.points.some(
        (p) =>
          p.trackId === r.track.id && Math.round(p.projectTime * 1000) === ms,
      )
    ) {
      return { ok: false, error: "该时刻已存在分镜点" };
    }
    const sourceTime = Math.round(r.sourceTime * 1000) / 1000;
    const point = {
      id: createPointId(),
      projectTime: t,
      trackId: r.track.id,
      sourceTime,
      // 帧状态：idle | loading | ok | stale | error
      frameStatus: "idle",
      frame: null, // Blob
      frameURL: null, // 展示用 objectURL
      // 缓存键（摘要算法+摘要+源时间）：建点时即按当前剪辑参数确定，
      // 不等首次取帧——导出清单随时能给出确定键
      frameKey: r.track.digest ? frameKeyFor(r.track.digest, sourceTime) : null,
      frameFromCache: false,
      // 帧代际：每次作废 +1；在途取帧/缓存回读只允许提交到同一代
      frameGen: 0,
    };
    this.points.push(point);
    this.points.sort((a, b) => a.projectTime - b.projectTime);
    return { ok: true, point };
  }

  /** 在整条项目时间轴上均匀放置 n 个点（空隙自动吸附、去重） */
  addPointsUniform(n) {
    n = Math.min(MAX_POINTS, Math.max(1, Math.floor(n)));
    const D = this.projectDuration();
    if (D <= 0) return { ok: false, error: "尚未导入任何视频", added: 0 };
    const added = [];
    for (let i = 0; i < n; i += 1) {
      if (this.points.length >= MAX_POINTS) break;
      const t = ((i + 0.5) * D) / n;
      const res = this.addPoint(t);
      if (res.ok) added.push(res.point);
    }
    return {
      ok: added.length > 0,
      added,
      error: added.length ? null : "所有候选时刻都重复或无覆盖",
    };
  }

  removePoint(id) {
    const i = this.points.findIndex((p) => p.id === id);
    if (i >= 0) this.points.splice(i, 1);
  }

  clearPoints() {
    this.points.length = 0;
  }

  /**
   * 轨道偏移/剪辑/替换/删除后重新解析每个点。
   * - 解析结果变化（换轨或源时间变化）的点立即丢弃旧帧并标记 stale：
   *   旧内容不允许继续占据新分镜，等待上层重新取帧；
   * - 失去覆盖的点与轨道解绑（trackId/sourceTime/frameKey 置空、帧作废），
   *   不再进入 confirmedSnapshot，也不会被按旧源时间重新取帧；
   *   之后若编辑/偏移使其重新被覆盖，会按新解析结果复活并重取。
   */
  _recomputePoints() {
    for (const p of this.points) {
      const r = this.resolve(p.projectTime);
      if (!r) {
        p.trackId = null;
        p.sourceTime = null;
        p.frameKey = null;
        this._invalidate(p, "idle");
        continue;
      }
      // 与 addPoint 同样归一化到毫秒桶：取帧键与导出源时间稳定一致
      const src = Math.round(r.sourceTime * 1000) / 1000;
      const key = r.track.digest ? frameKeyFor(r.track.digest, src) : null;
      if (p.trackId !== r.track.id || p.sourceTime !== src) {
        p.trackId = r.track.id;
        p.sourceTime = src;
        p.frameKey = key;
        this._invalidate(p, "stale");
      } else {
        p.sourceTime = src;
        p.frameKey = key;
      }
    }
  }

  /** 作废旧帧并推进帧代际：此前发起的在途取帧/缓存回读一律不得再提交 */
  _invalidate(point, status) {
    this._onPointInvalidate?.(point);
    point.frame = null;
    point.frameURL = null;
    point.frameFromCache = false;
    point.frameStatus = status ?? "idle";
    point.frameGen = (point.frameGen ?? 0) + 1;
  }

  /**
   * 已确认分镜点的唯一有序快照。
   * 点击播放、PNG 接触表、JSON 清单三者只能使用本方法返回的同一组点。
   * 与轨道解绑的点（编辑后失去覆盖）不进入快照。
   */
  confirmedSnapshot() {
    return [...this.points]
      .filter((p) => p.trackId && this.getTrack(p.trackId))
      .sort((a, b) => a.projectTime - b.projectTime);
  }
}

/**
 * 缩略帧缓存键：仅取决于文件内容摘要（算法+值）与源时间（与项目偏移、
 * 剪辑参数无关——同一源时刻的帧内容唯一）。
 * digest 可以是 {algo, hex} 对象或裸 hex 字符串（按 sha256 处理）；
 * 回退算法（fcs32）使用自己的前缀，两种算法不会互相撞键。
 */
export function frameKeyFor(digest, sourceTime) {
  const ms = Math.max(0, Math.round(sourceTime * 1000));
  const algo =
    digest && typeof digest === "object" ? (digest.algo ?? "sha256") : "sha256";
  const hex = digest && typeof digest === "object" ? digest.hex : digest;
  return `${algo}:${hex}/t${ms}`;
}
