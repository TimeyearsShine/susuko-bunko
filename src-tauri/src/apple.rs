use std::ffi::c_void;
use tauri::{plugin, Runtime};

extern "C" {
    fn susuko_install_apple_chrome(webview: *mut c_void);
}

pub fn interface<R: Runtime>() -> plugin::TauriPlugin<R> {
    let platform = if cfg!(target_os = "ios") { "ios" } else { "macos" };
    plugin::Builder::new("apple-interface")
        .js_init_script(format!("window.__susukoApplePlatform = '{platform}';"))
        .on_webview_ready(|webview| {
            if webview.label() == "main" {
                let _ = webview.with_webview(|webview| {
                    // Tauri passes its live WKWebView on the UI thread.
                    unsafe { susuko_install_apple_chrome(webview.inner()) };
                });
            }
        })
        .build()
}
