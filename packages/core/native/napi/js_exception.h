#ifndef OVERDRAW_NAPI_JS_EXCEPTION_H_
#define OVERDRAW_NAPI_JS_EXCEPTION_H_

// Helpers for surfacing JS exceptions thrown across the native->JS callback
// boundary. A callback invoked from a libuv-driven native path has no JS
// caller to propagate a throw to: napi leaves the exception pending, every
// subsequent napi call in the same native pass silently no-ops, and node
// never reports it. Any site that invokes a JS callback outside a JS frame
// must call takePendingJsException right after and log the result --
// otherwise one throwing callback swallows both the error and every
// remaining napi call of the pass.

#include <node_api.h>

#include <string>

namespace overdraw::napi {

// Stringify a thrown JS value: prefer err.stack (message + trace), fall
// back to String(err). Returns "" when nothing stringifies.
inline std::string describeJsValue(napi_env env, napi_value ex) {
    auto toStr = [&](napi_value v) -> std::string {
        napi_value str;
        if (napi_coerce_to_string(env, v, &str) != napi_ok) {
            // Coercion itself can throw (e.g. a Symbol); drop that too.
            napi_value pending;
            napi_get_and_clear_last_exception(env, &pending);
            return "";
        }
        size_t len = 0;
        napi_get_value_string_utf8(env, str, nullptr, 0, &len);
        std::string out;
        out.resize(len);
        size_t got = 0;
        napi_get_value_string_utf8(env, str, out.data(), len + 1, &got);
        return out;
    };
    std::string detail;
    napi_valuetype exType = napi_undefined;
    napi_typeof(env, ex, &exType);
    if (exType == napi_object || exType == napi_function) {
        napi_value stack;
        napi_valuetype t = napi_undefined;
        if (napi_get_named_property(env, ex, "stack", &stack) == napi_ok) {
            napi_typeof(env, stack, &t);
            if (t == napi_string) detail = toStr(stack);
        }
    }
    if (detail.empty()) detail = toStr(ex);
    return detail;
}

// If an exception is pending, clear it, fill *desc with its description,
// and return true. Returns false (desc untouched) when nothing is pending.
inline bool takePendingJsException(napi_env env, std::string* desc) {
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (!pending) return false;
    napi_value ex;
    if (napi_get_and_clear_last_exception(env, &ex) != napi_ok) {
        *desc = "<unretrievable exception>";
        return true;
    }
    *desc = describeJsValue(env, ex);
    if (desc->empty()) *desc = "<unstringifiable exception>";
    return true;
}

}  // namespace overdraw::napi

#endif  // OVERDRAW_NAPI_JS_EXCEPTION_H_
