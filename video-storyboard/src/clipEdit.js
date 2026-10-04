// 剪辑参数：源入点/源出点/倍速/反向。
// 本模块是唯一解释剪辑参数的地方——时间尺、点位解析、点击定位、
// 取帧键与导出源时间都必须经由 coverage()/sourceAt() 取得结果，
// 不允许任何一处绕开剪辑参数直接使用 track.duration。
//
// 不变量：
//  - validateEdit 要么返回完整合法的新剪辑，要么抛错——轨道状态绝不部分生效；
//  - 项目覆盖时长只由保留的源区间与倍速决定（反向不改变长度，
//    项目时间仍然正向流逝）；
//  - sourceAt 对正放/倒放给出确定性的源时间，且永远落在素材范围内。

export class ClipEditError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 校验并归一化剪辑参数。任何字段非法都整体抛错（调用方不得部分应用）。
 * @param track 仅读取 duration 作为合法区间上界
 * @param edit {in?, out?, rate?, reverse?} 缺省：整段、1 倍速、正放
 * @returns {{in:number, out:number, rate:number, reverse:boolean}}
 */
export function validateEdit(track, edit = {}) {
  const duration = track?.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ClipEditError("BAD_DURATION", `轨道时长无效，无法应用剪辑: ${duration}`);
  }
  const inPoint = Number(edit.in ?? 0);
  const outPoint = Number(edit.out ?? duration);
  const rate = Number(edit.rate ?? 1);
  const reverse = !!edit.reverse;

  if (!Number.isFinite(inPoint) || inPoint < 0 || inPoint > duration) {
    throw new ClipEditError(
      "BAD_IN",
      `无效入点: ${edit.in}（需在 0 ~ ${duration}s 之间）`,
    );
  }
  if (!Number.isFinite(outPoint) || outPoint < 0 || outPoint > duration) {
    throw new ClipEditError(
      "BAD_OUT",
      `无效出点: ${edit.out}（不能超过素材时长 ${duration}s）`,
    );
  }
  if (!(outPoint - inPoint > 0)) {
    throw new ClipEditError(
      "BAD_RANGE",
      `出点必须大于入点（当前 ${inPoint}s ~ ${outPoint}s）`,
    );
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new ClipEditError("BAD_RATE", `无效倍速: ${edit.rate}（必须为正的有限数）`);
  }
  return { in: inPoint, out: outPoint, rate, reverse };
}

/**
 * 轨道在项目时间轴上的覆盖时长：保留的源区间长度 / 倍速。
 * 无剪辑时即素材时长；反向不改变覆盖长度。
 */
export function coverage(track) {
  const e = track.edit;
  if (!e) return track.duration;
  return (e.out - e.in) / e.rate;
}

/**
 * 项目覆盖内的已流逝时间 -> 素材源时间。
 * 正放：in + elapsed*rate；倒放：out - elapsed*rate
 * （项目时间始终正向，源时间在反向时逆行）。
 * 结果钳制在 [0, duration] 内，浮点误差不会越界。
 */
export function sourceAt(track, elapsed) {
  const e = track.edit;
  const t = Math.min(Math.max(elapsed, 0), coverage(track));
  let src;
  if (!e) src = t;
  else src = e.reverse ? e.out - t * e.rate : e.in + t * e.rate;
  return Math.min(Math.max(src, 0), track.duration);
}
