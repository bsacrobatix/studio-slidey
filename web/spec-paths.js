// spec-paths — shared JSON-path helpers for the two web editors: the side form
// (SceneEditor.vue) and the in-place inline editor (inline-edit.js). A "path" is
// an array of string keys / numeric indices into the spec, e.g.
// ['scenes', 2, 'panels', 0, 'nodes', 1, 'label']. Keeping one implementation
// here means both editors mutate the spec identically.

export function getByPath(root, path) {
  return path.reduce((obj, key) => (obj == null ? undefined : obj[key]), root);
}

export function setByPath(root, path, value) {
  let obj = root;
  for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
  obj[path[path.length - 1]] = value;
}

// Coerce a raw input value to the kind the field expects. Mirrors the form's
// coercion so an inline-edited number doesn't get written back as a string.
export function coerceValue(raw, kind) {
  if (kind === 'boolean') return !!raw;
  if (kind === 'number') {
    if (raw === '') return '';
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}
