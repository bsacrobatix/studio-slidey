export function initialViewFromSearch(search) {
  const qs = new URLSearchParams(search || '');
  const scene = qs.get('scene');
  if (scene === null || scene === '') return null;
  const sceneIndex = Number(scene);
  const stepRaw = qs.get('step');
  const stepIndex = stepRaw === null || stepRaw === '' ? 0 : Number(stepRaw);
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0) return null;
  if (!Number.isInteger(stepIndex) || stepIndex < 0) return null;
  return { sceneIndex, stepIndex };
}
