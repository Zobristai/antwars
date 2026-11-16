#!/usr/bin/env python3
"""Automatic GStreamer discovery probe for the validation/org-packages-node fixture.

Run from the repository root:
    python3 validation-fixtures/probes/gstreamer-auto.py

Uses only the inherited environment and GStreamer's normal registry: it calls
gst_init, looks elements up by factory name, records the plugin each came from
and that plugin's file, then decodes an embedded H.264 clip through a
decodebin pipeline and asserts that avdec_h264 did the decoding. It never
scans a plugin path, sets a GST_PLUGIN_* variable or loads a plugin by
absolute path; the C libraries are loaded by soname through ctypes with
explicit signatures. A missing library is reported, not installed. The JSON
result is printed and saved under .validation/gstreamer/<run>/. Exit 0 only
when every check passed.
"""

import base64
import ctypes
import datetime
import hashlib
import json
import os
import sys

# Same clip as webkit-no-workaround.cjs: 64x48, 1 s, 10 fps H.264 Constrained
# Baseline MP4 (no audio), generated with a static ffmpeg build (libx264).
MEDIA_SHA256 = "4a00b557517d307b5874a42bd5a7976e91b6f955fe2f92d4964532237479382e"
MEDIA_BASE64 = (
    "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"
    "qTH8Lk1VV/0022/w"
)

ENV_NAMES = [
    "PATH",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GST_PLUGIN_PATH",
    "GST_PLUGIN_PATH_1_0",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_SCANNER",
    "GST_REGISTRY",
]
FACTORIES = ["filesrc", "decodebin", "qtdemux", "h264parse", "avdec_h264", "fakesink"]

GST_STATE_NULL = 1
GST_STATE_PLAYING = 4
GST_MESSAGE_EOS = 1 << 0
GST_MESSAGE_ERROR = 1 << 1
GST_ITERATOR_DONE = 0
GST_ITERATOR_OK = 1
GST_ITERATOR_RESYNC = 2
TIMEOUT_NS = 20 * 1000 * 1000 * 1000


class GError(ctypes.Structure):
    _fields_ = [("domain", ctypes.c_uint32), ("code", ctypes.c_int), ("message", ctypes.c_char_p)]


class GValue(ctypes.Structure):
    _fields_ = [("g_type", ctypes.c_size_t), ("data", ctypes.c_uint64 * 2)]


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def bind(lib, name, restype, argtypes):
    function = getattr(lib, name)
    function.restype = restype
    function.argtypes = argtypes
    return function


def mapped_gst_files():
    files = set()
    with open("/proc/self/maps", encoding="utf-8") as maps:
        for line in maps:
            parts = line.split(None, 5)
            if len(parts) == 6:
                path = parts[5].strip()
                if path.startswith("/") and ("gst" in path or "libav" in path):
                    files.add(path)
    return sorted(files)


def main():
    run_name = now_iso().replace(":", "-").replace(".", "-") + f"-{os.getpid()}"
    out_dir = os.path.abspath(os.path.join(".validation", "gstreamer", run_name))
    os.makedirs(out_dir, exist_ok=True)
    result = {
        "probe": "gstreamer-auto",
        "startedAt": now_iso(),
        "finishedAt": None,
        "outDir": out_dir,
        "python": sys.version,
        "uid": os.getuid(),
        "gid": os.getgid(),
        "environment": {name: os.environ.get(name) for name in ENV_NAMES},
        "gstreamerVersion": None,
        "factories": {},
        "pipeline": None,
        "elementsInstantiated": [],
        "mappedFiles": [],
        "checks": [],
        "error": None,
        "passed": False,
    }

    def check(name, passed, detail):
        result["checks"].append({"name": name, "passed": bool(passed), "detail": detail})

    def finish():
        result["passed"] = result["error"] is None and all(c["passed"] for c in result["checks"])
        result["finishedAt"] = now_iso()
        text = json.dumps(result, indent=2)
        with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print(text)
        return 0 if result["passed"] else 1

    media = base64.b64decode(MEDIA_BASE64)
    media_sha256 = hashlib.sha256(media).hexdigest()
    check("embedded media digest", media_sha256 == MEDIA_SHA256, {"expected": MEDIA_SHA256, "actual": media_sha256})
    media_path = os.path.join(out_dir, "fixture.mp4")
    with open(media_path, "wb") as handle:
        handle.write(media)

    try:
        glib = ctypes.CDLL("libglib-2.0.so.0")
        gobject = ctypes.CDLL("libgobject-2.0.so.0")
        gst = ctypes.CDLL("libgstreamer-1.0.so.0")
    except OSError as error:
        result["error"] = f"missing library: {error}"
        return finish()

    g_free = bind(glib, "g_free", None, [ctypes.c_void_p])
    g_error_free = bind(glib, "g_error_free", None, [ctypes.POINTER(GError)])
    g_value_get_object = bind(gobject, "g_value_get_object", ctypes.c_void_p, [ctypes.POINTER(GValue)])
    g_value_reset = bind(gobject, "g_value_reset", ctypes.c_void_p, [ctypes.POINTER(GValue)])
    g_value_unset = bind(gobject, "g_value_unset", None, [ctypes.POINTER(GValue)])

    gst_init = bind(gst, "gst_init", None, [ctypes.c_void_p, ctypes.c_void_p])
    gst_version = bind(gst, "gst_version", None, [ctypes.POINTER(ctypes.c_uint)] * 4)
    gst_object_unref = bind(gst, "gst_object_unref", None, [ctypes.c_void_p])
    gst_object_get_name = bind(gst, "gst_object_get_name", ctypes.c_void_p, [ctypes.c_void_p])
    gst_element_factory_find = bind(gst, "gst_element_factory_find", ctypes.c_void_p, [ctypes.c_char_p])
    gst_plugin_feature_get_plugin = bind(gst, "gst_plugin_feature_get_plugin", ctypes.c_void_p, [ctypes.c_void_p])
    gst_plugin_get_name = bind(gst, "gst_plugin_get_name", ctypes.c_char_p, [ctypes.c_void_p])
    gst_plugin_get_filename = bind(gst, "gst_plugin_get_filename", ctypes.c_char_p, [ctypes.c_void_p])
    gst_parse_launch = bind(
        gst, "gst_parse_launch", ctypes.c_void_p, [ctypes.c_char_p, ctypes.POINTER(ctypes.POINTER(GError))]
    )
    gst_element_set_state = bind(gst, "gst_element_set_state", ctypes.c_int, [ctypes.c_void_p, ctypes.c_int])
    gst_element_get_bus = bind(gst, "gst_element_get_bus", ctypes.c_void_p, [ctypes.c_void_p])
    gst_element_get_factory = bind(gst, "gst_element_get_factory", ctypes.c_void_p, [ctypes.c_void_p])
    gst_bus_timed_pop_filtered = bind(
        gst, "gst_bus_timed_pop_filtered", ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_int]
    )
    gst_message_get_structure = bind(gst, "gst_message_get_structure", ctypes.c_void_p, [ctypes.c_void_p])
    gst_structure_get_name = bind(gst, "gst_structure_get_name", ctypes.c_char_p, [ctypes.c_void_p])
    gst_message_parse_error = bind(
        gst,
        "gst_message_parse_error",
        None,
        [ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(GError)), ctypes.POINTER(ctypes.c_void_p)],
    )
    gst_mini_object_unref = bind(gst, "gst_mini_object_unref", None, [ctypes.c_void_p])
    gst_bin_iterate_recurse = bind(gst, "gst_bin_iterate_recurse", ctypes.c_void_p, [ctypes.c_void_p])
    gst_iterator_next = bind(gst, "gst_iterator_next", ctypes.c_int, [ctypes.c_void_p, ctypes.POINTER(GValue)])
    gst_iterator_resync = bind(gst, "gst_iterator_resync", None, [ctypes.c_void_p])
    gst_iterator_free = bind(gst, "gst_iterator_free", None, [ctypes.c_void_p])

    def object_name(pointer):
        raw = gst_object_get_name(pointer)
        if not raw:
            return None
        name = ctypes.string_at(raw).decode()
        g_free(raw)
        return name

    gst_init(None, None)
    parts = [ctypes.c_uint() for _ in range(4)]
    gst_version(*[ctypes.byref(part) for part in parts])
    result["gstreamerVersion"] = ".".join(str(part.value) for part in parts)

    for name in FACTORIES:
        factory = gst_element_factory_find(name.encode())
        entry = {"found": bool(factory), "plugin": None, "pluginFile": None}
        if factory:
            plugin = gst_plugin_feature_get_plugin(factory)
            if plugin:
                plugin_name = gst_plugin_get_name(plugin)
                plugin_file = gst_plugin_get_filename(plugin)
                entry["plugin"] = plugin_name.decode() if plugin_name else None
                entry["pluginFile"] = plugin_file.decode() if plugin_file else None
                gst_object_unref(plugin)
            gst_object_unref(factory)
        result["factories"][name] = entry
    avdec = result["factories"]["avdec_h264"]
    check("avdec_h264 found by registry lookup", avdec["found"] and avdec["pluginFile"], avdec)

    description = f'filesrc location="{media_path}" ! decodebin ! fakesink sync=false'
    result["pipeline"] = {"description": description, "outcome": None}
    parse_error = ctypes.POINTER(GError)()
    pipeline = gst_parse_launch(description.encode(), ctypes.byref(parse_error))
    if parse_error:
        result["pipeline"]["parseError"] = parse_error.contents.message.decode()
        g_error_free(parse_error)
    if not pipeline:
        check("decodebin pipeline reached EOS", False, result["pipeline"])
        return finish()

    gst_element_set_state(pipeline, GST_STATE_PLAYING)
    bus = gst_element_get_bus(pipeline)
    message = gst_bus_timed_pop_filtered(bus, TIMEOUT_NS, GST_MESSAGE_EOS | GST_MESSAGE_ERROR)
    if not message:
        result["pipeline"]["outcome"] = "timeout"
    else:
        structure = gst_message_get_structure(message)
        if not structure:
            result["pipeline"]["outcome"] = "eos"
        else:
            result["pipeline"]["outcome"] = (gst_structure_get_name(structure) or b"").decode()
            error = ctypes.POINTER(GError)()
            debug = ctypes.c_void_p()
            gst_message_parse_error(message, ctypes.byref(error), ctypes.byref(debug))
            if error:
                result["pipeline"]["error"] = error.contents.message.decode()
                g_error_free(error)
            if debug.value:
                result["pipeline"]["debug"] = ctypes.string_at(debug.value).decode(errors="replace")
                g_free(debug)
        gst_mini_object_unref(message)
    gst_object_unref(bus)

    iterator = gst_bin_iterate_recurse(pipeline)
    value = GValue()
    elements = []
    while True:
        status = gst_iterator_next(iterator, ctypes.byref(value))
        if status == GST_ITERATOR_OK:
            element = g_value_get_object(ctypes.byref(value))
            factory = gst_element_get_factory(element)
            elements.append({"element": object_name(element), "factory": object_name(factory) if factory else None})
            g_value_reset(ctypes.byref(value))
        elif status == GST_ITERATOR_RESYNC:
            elements = []
            gst_iterator_resync(iterator)
        else:
            break
    g_value_unset(ctypes.byref(value))
    gst_iterator_free(iterator)
    result["elementsInstantiated"] = elements
    result["mappedFiles"] = mapped_gst_files()

    gst_element_set_state(pipeline, GST_STATE_NULL)
    gst_object_unref(pipeline)

    check("decodebin pipeline reached EOS", result["pipeline"]["outcome"] == "eos", result["pipeline"])
    factories_used = sorted({entry["factory"] for entry in elements if entry["factory"]})
    check("avdec_h264 decoded the clip", "avdec_h264" in factories_used, factories_used)
    return finish()


if __name__ == "__main__":
    sys.exit(main())
