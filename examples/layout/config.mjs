// Example overdraw config: master-stack layout with an 8px gap between
// tiles and around the outer edge of the work area.
//
// The bundled master-stack plugin reads `config.layout`:
//   {
//     masterFraction?: number,   // 0.05..0.95, default 0.5
//     gap?:            number,   // logical px, default 0 (tiles touch)
//   }
//
// `gap` controls BOTH:
//   - the space between tiles (master <-> stack column, and between
//     stack slices), AND
//   - an outer band of the same width against the work area edges.
//
// Runtime tuning (the bundled core-actions registers these; bind to a
// hotkey or call from a custom action):
//   layout.grow-master / layout.shrink-master  -- 0.05 step
//   layout.grow-gap    / layout.shrink-gap     -- 4 px step (>= 0)
//
// Run:
//   npm run build:js
//   node packages/core/dist/main.js --config examples/layout/config.mjs

export default {
  layout: {
    masterFraction: 0.55,
    gap: 8,
  },
};
