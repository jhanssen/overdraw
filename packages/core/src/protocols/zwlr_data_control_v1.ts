// zwlr_data_control_v1: legacy data-control family, served by the shared
// implementation in ext_data_control_v1.ts. wl-clipboard <= 2.2.1 and
// older clipboard managers bind only this variant; without it wl-copy
// maps an invisible toplevel to grab focus, which a tiler reflows
// around. The shared handlers are interface-agnostic (event senders are
// picked per resource by interface name), so this module only re-exports
// the factories under the zwlr registration names.

export { default } from "./ext_data_control_v1.js";
export {
  makeExtDataControlDevice as makeZwlrDataControlDevice,
  makeExtDataControlSource as makeZwlrDataControlSource,
  makeExtDataControlOffer as makeZwlrDataControlOffer,
} from "./ext_data_control_v1.js";
