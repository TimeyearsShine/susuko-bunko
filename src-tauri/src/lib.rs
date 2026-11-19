// 原生外壳提供苹果端界面控件和百度网盘设备直连。网页里的 fetch 不能设置 User-Agent，
// 也会被跨域限制挡住，所以由这里带着百度要求的请求头去下载，支持 Range 和跳转。
mod cloud;
#[cfg(any(target_os = "ios", target_os = "macos"))]
mod apple;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    let builder = builder.plugin(apple::interface());
    builder
        .manage(cloud::Http::new())
        .invoke_handler(tauri::generate_handler![cloud::cloud_range])
        .run(tauri::generate_context!())
        .expect("failed to start Susuko Bunko");
}
