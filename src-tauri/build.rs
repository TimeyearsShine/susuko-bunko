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
}
