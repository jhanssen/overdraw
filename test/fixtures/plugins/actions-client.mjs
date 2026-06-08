// Fixture: a plugin that invokes actions on another plugin via
// sdk.actions.invoke. The test triggers calls by emitting window.map
// events with surfaceId codes:
//   1 = invoke math.add(2, 3)
//   2 = invoke math.mul(4, 5)
//   3 = invoke throws()
//   4 = invoke nonexistent.action
//   5 = list and log all actions
//   6 = invoke async.action({ delay: 30 })
export default async function init(sdk) {
  sdk.window.onMap(async (ev) => {
    const op = ev.surfaceId;
    try {
      if (op === 1) {
        const r = await sdk.actions.invoke("math.add", { a: 2, b: 3 });
        sdk.log(`add=${r}`);
      } else if (op === 2) {
        const r = await sdk.actions.invoke("math.mul", { a: 4, b: 5 });
        sdk.log(`mul=${r}`);
      } else if (op === 3) {
        try {
          await sdk.actions.invoke("throws");
          sdk.log("throws-no-throw");
        } catch (err) {
          sdk.log(`throws-err ${err.message}`);
        }
      } else if (op === 4) {
        try {
          await sdk.actions.invoke("nonexistent.action");
          sdk.log("nonexistent-no-throw");
        } catch (err) {
          sdk.log(`nonexistent-err ${err.message}`);
        }
      } else if (op === 5) {
        const list = await sdk.actions.list();
        const names = list.map((a) => a.name).join(",");
        sdk.log(`list=${names}`);
      } else if (op === 6) {
        const r = await sdk.actions.invoke("async.action", { delay: 30 });
        sdk.log(`async=${r}`);
      }
    } catch (err) {
      sdk.log(`unexpected-err ${err.message}`);
    }
  });
  sdk.log("ready");
}
