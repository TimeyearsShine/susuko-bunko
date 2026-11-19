fn main() {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    build_apple_interface();
    tauri_build::build();
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn build_apple_interface() {
    let platform = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let framework = match platform.as_str() {
        "ios" => "UIKit",
        "macos" => "AppKit",
        _ => return,
    };
    println!("cargo:rerun-if-changed=native/apple_chrome.m");
    cc::Build::new()
        .file("native/apple_chrome.m")
        .flag("-fobjc-arc")
        .compile("susuko_apple_chrome");
    println!("cargo:rustc-link-lib=framework={framework}");
    println!("cargo:rustc-link-lib=framework=WebKit");
    if platform == "macos" {
        link_clang_runtime();
    }
}

/// Objective-C 的 @available 要用到 clang 运行库里的 __isPlatformVersionAtLeast。
/// iOS 由 Xcode 最后链接时自动带上；macOS 由 rustc 链接（-nodefaultlibs），要手动加上。
/// 静态库只会取用到的那一小块，不会和 Rust 自己的内建函数冲突。
#[cfg(any(target_os = "ios", target_os = "macos"))]
fn link_clang_runtime() {
    let Ok(out) = std::process::Command::new("xcrun").args(["clang", "--print-resource-dir"]).output() else { return };
    let resource = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let dir = std::path::Path::new(&resource).join("lib").join("darwin");
    if dir.join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    } else {
        println!("cargo:warning=没找到 libclang_rt.osx.a（{}），macOS 链接可能失败", dir.display());
    }
}
