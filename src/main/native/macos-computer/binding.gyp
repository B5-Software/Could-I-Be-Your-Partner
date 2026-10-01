{
  "targets": [{
    "target_name": "cibyp_computer",
    "sources": ["computer.mm"],
    "defines": ["NAPI_VERSION=8"],
    "xcode_settings": {
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "MACOSX_DEPLOYMENT_TARGET": "12.0",
      "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"],
      "OTHER_LDFLAGS": ["-framework AppKit", "-framework ApplicationServices"]
    }
  }]
}
