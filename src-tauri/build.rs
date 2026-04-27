fn main() {
    println!("cargo:rerun-if-changed=../app-icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.ico");

    // Compile the vendored TAK Protocol v1 .proto files into Rust
    // structs via prost. We use protox (pure-Rust protoc replacement)
    // instead of relying on a system `protoc` install — keeps clean
    // dev machines and CI green without an extra binary dependency.
    println!("cargo:rerun-if-changed=proto/takmessage.proto");
    let descriptors = protox::compile(["proto/takmessage.proto"], ["proto/"])
        .expect("protox: compile takmessage.proto");
    prost_build::Config::new()
        .compile_fds(descriptors)
        .expect("prost-build: compile FileDescriptorSet");

    tauri_build::build()
}
