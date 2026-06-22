// Naming helpers shared by both emitters. The .js and .d.ts must agree on
// enum-const names (the .js provides the runtime value, the .d.ts its type),
// so these live in one place rather than being duplicated per emitter.

// foo_bar -> FooBar (interface name -> resource/type prefix).
export function pascal(name) {
  return name.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

// An enum entry name as an object key: bare if a valid identifier, else quoted
// (Wayland enum entries can start with a digit, e.g. orientation `0`).
export function tsEnumKey(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`;
}
