// Fixture: a plugin that drives sdk.windows.* operations on demand. The test
// emits window.map events with operation codes (surfaceId) to trigger:
//   1 = setFloating(targetId, true)
//   2 = setFloating(targetId, false)
//   3 = setFullscreen(targetId, true)
//   4 = setState(targetId, 'workspace.id', 7)
//   5 = getState(targetId, 'workspace.id') and log it
//   6 = deleteState(targetId, 'workspace.id')
//   7 = get(targetId) and log the snapshot
//   8 = list() and log the count + first surfaceId
//   9 = setOutputStack(0, [100, targetId])
//  10 = setOutputStack(0, null) -- clear override
//  11 = setOpacity(targetId, 0.5)
//  12 = setTransform(targetId, {translateX:10, translateY:20, scaleX:2, scaleY:2})
//  13 = setOutputMargin(targetId, {top:4, right:8, bottom:12, left:16})
//  14 = setTint(targetId, {r:0.5, g:0.6, b:0.7, a:1})
//  15 = setColorMatrix(targetId, identity-16-array)
//  16 = requestFocusDecision('workspace-changed')
//
// targetId is provided via window.change events' surfaceId field (only the
// LAST change event's surfaceId is used).
export default async function init(sdk) {
  let targetId = null;

  sdk.windows.onChange((ev) => {
    // Just to capture a surfaceId; the test fires this to set the target.
    if (ev.changed.includes('title') && typeof ev.title === 'string' && ev.title.startsWith('TARGET:')) {
      targetId = parseInt(ev.title.slice(7), 10);
      sdk.log(`target=${targetId}`);
    } else {
      sdk.log(`CHANGE ${JSON.stringify(ev)}`);
    }
  });

  sdk.windows.onMap(async (ev) => {
    const op = ev.surfaceId;
    if (op === 1) { await sdk.windows.setFloating(targetId, true); sdk.log('set-floating-true'); return; }
    if (op === 2) { await sdk.windows.setFloating(targetId, false); sdk.log('set-floating-false'); return; }
    if (op === 3) { await sdk.windows.setFullscreen(targetId, true); sdk.log('set-fullscreen-true'); return; }
    if (op === 4) { await sdk.windows.setState(targetId, 'workspace.id', 7); sdk.log('set-state'); return; }
    if (op === 5) {
      const v = await sdk.windows.getState(targetId, 'workspace.id');
      sdk.log(`get-state=${JSON.stringify(v)}`);
      return;
    }
    if (op === 6) { await sdk.windows.deleteState(targetId, 'workspace.id'); sdk.log('delete-state'); return; }
    if (op === 7) {
      const s = await sdk.windows.get(targetId);
      sdk.log(`get=${JSON.stringify(s)}`);
      return;
    }
    if (op === 8) {
      const l = await sdk.windows.list();
      sdk.log(`list-count=${l.length}` + (l.length ? ` first=${l[0].surfaceId}` : ''));
      return;
    }
    if (op === 9) {
      await sdk.windows.setOutputStack(0, [100, targetId]);
      sdk.log('set-output-stack');
      return;
    }
    if (op === 10) {
      await sdk.windows.setOutputStack(0, null);
      sdk.log('clear-output-stack');
      return;
    }
    if (op === 11) {
      await sdk.windows.setOpacity(targetId, 0.5);
      sdk.log('set-opacity');
      return;
    }
    if (op === 12) {
      await sdk.windows.setTransform(targetId,
        { translateX: 10, translateY: 20, scaleX: 2, scaleY: 2 });
      sdk.log('set-transform');
      return;
    }
    if (op === 13) {
      await sdk.windows.setOutputMargin(targetId,
        { top: 4, right: 8, bottom: 12, left: 16 });
      sdk.log('set-output-margin');
      return;
    }
    if (op === 14) {
      await sdk.windows.setTint(targetId, { r: 0.5, g: 0.6, b: 0.7, a: 1 });
      sdk.log('set-tint');
      return;
    }
    if (op === 15) {
      await sdk.windows.setColorMatrix(targetId, [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
      sdk.log('set-color-matrix');
      return;
    }
    if (op === 16) {
      await sdk.windows.requestFocusDecision('workspace-changed');
      sdk.log('request-focus-decision');
      return;
    }
  });

  sdk.log('ready');
}
