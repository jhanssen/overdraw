// Fixture (in-thread bundled): exercises sdk.cursor.* end-to-end.
// Tests pass `mode` in config to pick which behavior to verify.
//
// mode = 'setShape':   sdk.cursor.setShape('default') (explicit override)
// mode = 'rule-speed': defineRule(when: speedRange: [200, Infinity]); the
//                      installed shape is a known theme name.
// mode = 'rule-shake': defineRule(when: shake: true)

export default async function init(sdk, config) {
  sdk.log(`cursor-rule plugin init mode=${config?.mode}`);
  if (!sdk.cursor) {
    sdk.log("no sdk.cursor; bailing");
    return;
  }
  const mode = config?.mode;
  if (mode === "setShape") {
    await sdk.cursor.setShape(config.shape ?? "default");
    sdk.log("setShape done");
  } else if (mode === "rule-speed") {
    const lo = config?.lo ?? 200;
    const hi = config?.hi ?? Infinity;
    await sdk.cursor.defineRule({
      when: { speedRange: [lo, hi] },
      shape: config?.shape ?? "default",
    });
    sdk.log("rule-speed defined");
  } else if (mode === "rule-shake") {
    await sdk.cursor.defineRule({
      when: { shake: true },
      shape: config?.shape ?? "default",
    });
    sdk.log("rule-shake defined");
  } else if (mode === "hide") {
    await sdk.cursor.hide();
    sdk.log("hide done");
  } else if (mode === "clearOverride") {
    await sdk.cursor.setShape("default");
    await sdk.cursor.clearOverride();
    sdk.log("clearOverride done");
  }
}
