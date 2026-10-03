// 剪辑参数：源入点/源出点、倍速、反向。
// 不变量：
//  - validateEdit 整体校验，任一字段非法即抛 ClipEditError；调用方只在
//    校验通过后才写入 track.edit —— 剪辑要么完整生效，要么原样保留，
//    绝不存在“部分生效”的轨道状态；
//  - coverage() 是轨道在项目时间轴上的覆盖长度（剪辑感知），时间尺、
//    项目总时长、空隙判定、点位归属全部以此为准；
//  - sourceAt() 把“距轨道起点的项目经过时长”映射为源时间；反向时源时间
//    从出点走向入点，项目时间始终正向推进。

export class ClipEditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 覆盖不足 1ms 的剪辑对毫秒级分镜没有意义（点位按毫秒桶归一化）
const MIN_COVERAGE = 0.001;

const roundMs = (x) => Math.round(x * 1000) / 1000;

/**
 * 校验并规范化剪辑参数。edit 为 null/undefined 表示清除剪辑（恢复整段）。
 * 缺省字段按“不剪辑”取默认：in=0、out=素材时长、rate=1、reverse=false。
 * 入出点归一化到毫秒桶，与分镜点源时间的精度一致。
 * @throws {ClipEditError} 任一字段非法（调用方据此保证不部分应用）
 */
export function validateEdit(track, edit) {
  if (edit == null) return null;
  const dur = track.duration;
  const inP = edit.in === undefined ? 0 : Number(edit.in);
  const outP = edit.out === undefined ? dur : Number(edit.out);
  const rate = edit.rate === undefined ? 1 : Number(edit.rate);
  const reverse = !!edit.reverse;

  if (!Number.isFinite(inP) || inP < 0 || inP >= dur) {
    throw new ClipEditError(
      "BAD_EDIT",
      `入点必须在 [0, ${dur}) 秒内：${edit.in}`,
    );
  }
  if (!Number.isFinite(outP) || outP > dur) {
    throw new ClipEditError(
      "BAD_EDIT",
      `出点不能超过素材时长 ${dur} 秒：${edit.out}`,
    );
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new ClipEditError("BAD_EDIT", `倍速必须为正的有限数：${edit.rate}`);
  }
  const nIn = roundMs(inP);
  const nOut = roundMs(outP);
  if (nOut <= nIn) {
    throw new ClipEditError(
      "BAD_EDIT",
      `出点必须大于入点（入 ${nIn}s / 出 ${nOut}s）`,
    );
  }
  if ((nOut - nIn) / rate < MIN_COVERAGE) {
    throw new ClipEditError(
      "BAD_EDIT",
      "剪辑后的项目覆盖时长不足 1ms，无法放置分镜点",
    );
  }
  return { in: nIn, out: nOut, rate, reverse };
}

/** 轨道在项目时间轴上的覆盖长度（秒）：保留的源区间 ÷ 倍速 */
export function coverage(track) {
  const e = track.edit;
  if (!e) return track.duration;
  return (e.out - e.in) / e.rate;
}

/**
 * 距轨道起点 elapsed 秒（项目时间，始终正向）对应的源时间。
 * 正向：in + elapsed*rate；反向：out - elapsed*rate。
 * 结果钳制在保留区间 [in, out]（无剪辑时 [0, duration]），
 * 浮点越界不会泄漏到区间外。
 */
export function sourceAt(track, elapsed) {
  const e = track.edit;
  if (!e) return Math.min(Math.max(elapsed, 0), track.duration);
  const t = e.reverse ? e.out - elapsed * e.rate : e.in + elapsed * e.rate;
  return Math.min(Math.max(t, e.in), e.out);
}
