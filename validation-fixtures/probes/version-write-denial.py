#!/usr/bin/env python3
"""Write-denial probe for an installed package version folder.

Usage:
    python3 validation-fixtures/probes/version-write-denial.py <directory> [<directory> ...]

Pass the exact version root and representative lib/alternative directories.
For each directory, as the current (unchanged) user, the probe tries
open(<directory>/<unique run name>, O_CREAT | O_EXCL | O_WRONLY, 0600).
Only EACCES or EROFS with no file created is a pass. ENOENT (wrong or missing
path) and every other error is a failure. If the file is unexpectedly
created, that is a failure: the probe closes it, removes only that empty file,
and records the cleanup. It never changes permissions or ownership and never
writes to an existing file. The JSON result, with the errno, user identity,
stat and mount facts, before/after listings and UTC timestamps, is printed to
stdout. Exit 0 only when every directory denied the write; exit 2 on usage
error.
"""

import datetime
import errno
import grp
import hashlib
import json
import os
import pwd
import secrets
import sys

LISTING_LIMIT = 500


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def identity():
    uid = os.getuid()
    gid = os.getgid()

    def user_name(value):
        try:
            return pwd.getpwuid(value).pw_name
        except KeyError:
            return None

    def group_name(value):
        try:
            return grp.getgrgid(value).gr_name
        except KeyError:
            return None

    return {
        "uid": uid,
        "euid": os.geteuid(),
        "user": user_name(uid),
        "gid": gid,
        "egid": os.getegid(),
        "group": group_name(gid),
        "groups": [{"gid": value, "name": group_name(value)} for value in os.getgroups()],
    }


def unescape_mount_path(value):
    return value.replace("\\040", " ").replace("\\011", "\t").replace("\\012", "\n").replace("\\134", "\\")


def mount_for(path):
    """The /proc/self/mountinfo entry with the longest mount point containing path."""
    best = None
    with open("/proc/self/mountinfo", encoding="utf-8") as mountinfo:
        for line in mountinfo:
            left, _, right = line.rstrip("\n").partition(" - ")
            fields = left.split(" ")
            mount_point = unescape_mount_path(fields[4])
            inside = path == mount_point or path.startswith(mount_point.rstrip("/") + "/")
            if inside and (best is None or len(mount_point) >= len(best["mountPoint"])):
                right_fields = right.split(" ")
                best = {
                    "mountPoint": mount_point,
                    "mountOptions": fields[5],
                    "fsType": right_fields[0] if right_fields else None,
                    "source": right_fields[1] if len(right_fields) > 1 else None,
                    "superOptions": right_fields[2] if len(right_fields) > 2 else None,
                }
    return best


def listing(path):
    try:
        names = sorted(os.listdir(path))
    except OSError as error:
        return {"error": errno.errorcode.get(error.errno, str(error.errno))}
    digest = hashlib.sha256("\n".join(names).encode("utf-8", "surrogateescape")).hexdigest()
    return {
        "count": len(names),
        "sha256": digest,
        "names": names[:LISTING_LIMIT],
        "truncated": len(names) > LISTING_LIMIT,
        "_all": names,
    }


def stat_facts(path):
    st = os.stat(path)
    vfs = os.statvfs(path)
    return {
        "mode": oct(st.st_mode),
        "uid": st.st_uid,
        "gid": st.st_gid,
        "device": st.st_dev,
        "inode": st.st_ino,
        "statvfsReadOnly": bool(vfs.f_flag & os.ST_RDONLY),
        "accessWriteForCaller": os.access(path, os.W_OK),
    }


def probe_directory(path, run_name):
    record = {
        "path": path,
        "realPath": os.path.realpath(path),
        "startedAt": now_iso(),
        "target": os.path.join(path, run_name),
        "stat": None,
        "mount": None,
        "before": None,
        "after": None,
        "openErrno": None,
        "openErrorMessage": None,
        "created": False,
        "cleanup": None,
        "outcome": None,
        "reason": None,
    }
    try:
        record["stat"] = stat_facts(path)
    except OSError as error:
        record["openErrno"] = errno.errorcode.get(error.errno, str(error.errno))
        record["openErrorMessage"] = error.strerror
        record["outcome"] = "fail"
        record["reason"] = "directory could not be examined (wrong or missing path)"
        record["finishedAt"] = now_iso()
        return record
    if not os.path.isdir(path):
        record["outcome"] = "fail"
        record["reason"] = "not a directory"
        record["finishedAt"] = now_iso()
        return record

    record["mount"] = mount_for(record["realPath"])
    before = listing(path)
    record["beforeAt"] = now_iso()

    try:
        descriptor = os.open(record["target"], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except OSError as error:
        record["openAt"] = now_iso()
        record["openErrno"] = errno.errorcode.get(error.errno, str(error.errno))
        record["openErrorMessage"] = error.strerror
        if error.errno in (errno.EACCES, errno.EROFS):
            record["outcome"] = "pass"
            record["reason"] = "write denied"
        else:
            record["outcome"] = "fail"
            record["reason"] = "open failed with an errno other than EACCES or EROFS"
    else:
        record["openAt"] = now_iso()
        record["created"] = True
        os.close(descriptor)
        record["outcome"] = "fail"
        record["reason"] = "file was unexpectedly created"
        size = os.stat(record["target"]).st_size
        if size == 0:
            os.unlink(record["target"])
            record["cleanup"] = {"removed": record["target"], "size": size, "at": now_iso()}
        else:
            record["cleanup"] = {"removed": None, "size": size, "at": now_iso(), "note": "not empty; left in place"}

    after = listing(path)
    record["afterAt"] = now_iso()
    if "_all" in before and "_all" in after:
        before_set = set(before["_all"])
        after_set = set(after["_all"])
        record["listingChanged"] = {
            "added": sorted(after_set - before_set),
            "removed": sorted(before_set - after_set),
        }
        if record["outcome"] == "pass" and (after_set - before_set):
            record["outcome"] = "fail"
            record["reason"] = "write reported denied but the listing gained entries"
    before.pop("_all", None)
    after.pop("_all", None)
    record["before"] = before
    record["after"] = after
    record["finishedAt"] = now_iso()
    return record


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    started = now_iso()
    run_name = ".write-denial-probe-{}-{}-{}".format(
        started.replace(":", "-").replace(".", "-"), os.getpid(), secrets.token_hex(4)
    )
    directories = [probe_directory(path, run_name) for path in argv[1:]]
    result = {
        "probe": "version-write-denial",
        "startedAt": started,
        "runName": run_name,
        "identity": identity(),
        "directories": directories,
        "finishedAt": now_iso(),
        "passed": all(entry["outcome"] == "pass" for entry in directories),
    }
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
