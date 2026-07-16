#pragma once

#include <node_api.h>

namespace overdraw {

// Microtask-draining scope for JS calls made from raw libuv callbacks.
//
// Node drains the V8 microtask queue only when its own callback machinery
// (an InternalCallbackScope) unwinds; napi_call_function alone does not.
// A JS callback invoked straight from a uv_poll/uv_async/uv_timer handler
// therefore leaves every promise continuation it queued parked in the
// microtask queue until some unrelated node-owned event (a JS timer, a net
// socket) happens to fire. In a compositor whose entire steady-state load
// is addon-driven, that stalls protocol and plugin promise chains for
// hundreds of milliseconds to tens of seconds.
//
// Open one of these before calling into JS from a libuv callback; the
// destructor runs the microtask checkpoint. Nested opens are counted by
// node and drain only at the outermost close, so wrapping a callback that
// re-enters another wrapped path is safe.
class UvJsScope {
  public:
    UvJsScope(napi_env env, napi_async_context ctx) : env_(env) {
        if (napi_open_handle_scope(env_, &handleScope_) != napi_ok) {
            handleScope_ = nullptr;
            return;
        }
        if (!ctx) return;  // context not initialized yet; plain calls only
        napi_value undef{};
        napi_get_undefined(env_, &undef);
        if (napi_open_callback_scope(env_, undef, ctx, &cbScope_) != napi_ok) {
            cbScope_ = nullptr;
        }
    }
    ~UvJsScope() {
        if (cbScope_) napi_close_callback_scope(env_, cbScope_);
        if (handleScope_) napi_close_handle_scope(env_, handleScope_);
    }
    UvJsScope(const UvJsScope&) = delete;
    UvJsScope& operator=(const UvJsScope&) = delete;

  private:
    napi_env env_;
    napi_handle_scope handleScope_ = nullptr;
    napi_callback_scope cbScope_ = nullptr;
};

// One-time creation of the async context UvJsScope needs. The resource
// object exists only for async_hooks attribution.
inline napi_async_context makeUvJsAsyncContext(napi_env env, const char* name) {
    napi_value resName{};
    napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resName);
    napi_value resource{};
    napi_create_object(env, &resource);
    napi_async_context ctx = nullptr;
    napi_async_init(env, resource, resName, &ctx);
    return ctx;
}

}  // namespace overdraw
