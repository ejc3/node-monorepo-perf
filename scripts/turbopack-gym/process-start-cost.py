#!/usr/bin/env python3
#   taskset -c 0-3 python3 scripts/turbopack-gym/process-start-cost.py [reps]
# Cost of starting a child process from a parent holding a large, touched heap: fork+exec
# (what libuv does on Linux) against posix_spawn (glibc: clone with CLONE_VM|CLONE_VFORK, no
# page-table copy). Parent heap sizes 0..16 GiB of 4 KiB pages, each page written once.
# Prints JSON lines: {"gib", "method", "ms_median", "ms_min", "ms_max"} per (size, method).
import os, sys, time, json, mmap, statistics
reps = int(sys.argv[1]) if len(sys.argv) > 1 else 15
sizes = [0, 1, 4, 8, 16]
def reap(pid):
    # a launch that did not run /bin/true to exit 0 is not a sample
    status = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
    if status != 0:
        sys.exit(f"child {pid} exited {status}")
def spawn_fork():
    pid = os.fork()
    if pid == 0:
        os.execv("/bin/true", ["/bin/true"])
    reap(pid)
def spawn_posix():
    pid = os.posix_spawn("/bin/true", ["/bin/true"], os.environ)
    reap(pid)
heap = []
held = 0
for gib in sizes:
    while held < gib:
        m = mmap.mmap(-1, 1 << 30, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS)
        for off in range(0, 1 << 30, 4096):
            m[off] = 1
        heap.append(m)
        held += 1
    for name, f in (("fork+exec", spawn_fork), ("posix_spawn", spawn_posix)):
        f()
        ts = []
        for _ in range(reps):
            t = time.perf_counter(); f(); ts.append((time.perf_counter() - t) * 1000)
        print(json.dumps({"gib": gib, "method": name, "ms_median": round(statistics.median(ts), 2),
                          "ms_min": round(min(ts), 2), "ms_max": round(max(ts), 2)}), flush=True)
