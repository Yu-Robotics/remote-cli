{
  "targets": [{
    "target_name": "managed_native",
    "sources": ["managed_native.c"],
    "defines": ["NAPI_VERSION=8"],
    "conditions": [["OS=='win'", {"defines": ["_WIN32_WINNT=0x0A00"]}], ["OS=='mac'", {"libraries": ["-lproc"]}]]
  }]
}
