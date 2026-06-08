// Fixture: a plugin that consumes the 'calc' namespace and exercises method
// calls. Each test orchestrates what to call via a window.* signal (re-using
// the existing core->plugin event channel; no new wiring needed).
//
// The fixture logs every result/error so the test can observe outcomes via
// onEvent.
export default async function init(sdk) {
  sdk.log("client-init");

  // Obtain the proxy lazily on demand: the test triggers calls by emitting
  // window.map with a surfaceId that codes the operation. (Surface 0 reserved
  // for "obtain proxy now"; positive ids code operations.)
  let calc = null;

  async function ensureCalc() {
    if (!calc) {
      try {
        calc = await sdk.plugin("calc");
        sdk.log("got-proxy");
      } catch (err) {
        sdk.log("proxy-error " + (err?.message ?? String(err)));
      }
    }
    return calc;
  }

  sdk.window.onMap(async (ev) => {
    const op = ev.surfaceId;
    if (op === 0) { await ensureCalc(); return; }
    if (op === 1) {
      const c = await ensureCalc();
      try {
        const r = await c.add(2, 3);
        sdk.log("add=" + r);
      } catch (err) { sdk.log("add-error " + err.message); }
      return;
    }
    if (op === 2) {
      const c = await ensureCalc();
      try {
        const r = await c.mul(4, 5);
        sdk.log("mul=" + r);
      } catch (err) { sdk.log("mul-error " + err.message); }
      return;
    }
    if (op === 3) {
      const c = await ensureCalc();
      try { await c.boom(); sdk.log("boom-no-throw"); }
      catch (err) { sdk.log("boom-error " + err.message); }
      return;
    }
    if (op === 4) {
      const c = await ensureCalc();
      try { await c.nonexistent(7); sdk.log("nonexistent-no-throw"); }
      catch (err) { sdk.log("nonexistent-error " + err.message); }
      return;
    }
  });

  sdk.log("ready");
}
