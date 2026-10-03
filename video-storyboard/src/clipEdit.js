export function validateEdit(track, edit) {
  return { ...edit };
}
export function coverage(track) {
  return track.duration;
}
export function sourceAt(track, elapsed) {
  const e = track.edit;
  return e ? e.in + elapsed * e.rate : elapsed;
}
