import { describe, expect, it } from "vitest";
import { parseTrace, tracedCommand } from "../scripts/lib/strace.js";

const CODEX = "/opt/codex/vendor/t/bin/codex";
const REWRITES = [
  { label: "<probe>", path: "/tmp/probe-x" },
  { label: "<codex>", path: "/opt/codex/vendor/t" },
];
const root = `10 execve("${CODEX}", ["${CODEX}", "app-server", "--strict-config"], 0x1 /* 64 vars */) = 0`;
const parse = (...lines: string[]) =>
  parseTrace(
    [root, ...lines].join("\n"),
    CODEX,
    REWRITES,
    new Map([["127.0.0.1:8080", "<loopback>"]]),
  );

describe("strace exec record", () => {
  it("keeps exact argv, sets the traced command aside and rewrites only the listed paths", () => {
    const trace = parse(
      '11 execve("/opt/codex/vendor/t/codex-path/lsb_release", ["lsb_release", "-a"], 0x2 /* 64 vars */) = -1 ENOENT (No such file or directory)',
      '11 execve("/usr/bin/lsb_release", ["lsb_release", "-a"], 0x2 /* 64 vars */) = 0',
      '12 execve("/usr/bin/cut", ["cut", "-c1"], 0x3 /* 65 vars */ <unfinished ...>',
      "12 <... execve resumed>) = 0",
      '13 execve("/bin/sh", ["sh", "-c", "/tmp/probe-x/run /tmp/other"], 0x4 /* 1 vars */ <unfinished ...>',
      "13 <... execve resumed>) = -1 EACCES (Permission denied)",
      '14 execve("/tmp/probe-x/chome/tool", ["tool", "/tmp/other"], 0x4 /* 1 vars */) = 0',
    );
    expect(trace.error).toBeNull();
    expect(trace.root).toBe(
      JSON.stringify(["<codex>/bin/codex", "<codex>/bin/codex", "app-server", "--strict-config"]),
    );
    expect(trace.execs).toEqual([
      JSON.stringify(["/usr/bin/lsb_release", "lsb_release", "-a"]),
      JSON.stringify(["/usr/bin/cut", "cut", "-c1"]),
      JSON.stringify(["<probe>/chome/tool", "tool", "/tmp/other"]),
    ]);
    expect(trace.raw[2]).toBe(JSON.stringify(["/tmp/probe-x/chome/tool", "tool", "/tmp/other"]));
  });

  it("distinguishes argv[0] and argument boundaries", () => {
    const trace = parse(
      '11 execve("/bin/busybox", ["sh", "-c", "id"], 0x2 /* 1 vars */) = 0',
      '12 execve("/bin/busybox", ["ls", "-c", "id"], 0x2 /* 1 vars */) = 0',
      '13 execve("/bin/echo", ["echo", "a b"], 0x2 /* 1 vars */) = 0',
      '14 execve("/bin/echo", ["echo", "a", "b"], 0x2 /* 1 vars */) = 0',
    );
    expect(new Set(trace.execs).size).toBe(4);
  });

  it("reads the result after the arguments, not inside them", () => {
    const trace = parse(
      '11 execve("/bin/echo", ["echo", ") = 0"], 0x2 /* 1 vars */) = -1 EACCES (Permission denied)',
      '12 execve("/bin/echo", ["echo", "\\") = -1"], 0x2 /* 1 vars */) = 0',
    );
    expect(trace.execs).toEqual([JSON.stringify(["/bin/echo", "echo", '\\") = -1'])]);
  });

  it("resolves execveat against the descriptor strace printed and refuses unknown directories", () => {
    const three = parse(
      '11 execveat(3</usr/lib/a>, "helper", ["helper"], 0x2 /* 1 vars */, 0) = 0',
    );
    const four = parse('11 execveat(4</usr/lib/b>, "helper", ["helper"], 0x2 /* 1 vars */, 0) = 0');
    expect(three.execs).toEqual([JSON.stringify(["/usr/lib/a/helper", "helper"])]);
    expect(four.execs).toEqual([JSON.stringify(["/usr/lib/b/helper", "helper"])]);
    expect(parse('11 execveat(3, "helper", ["helper"], 0x2 /* 1 vars */, 0) = 0').error).toContain(
      "relative path",
    );
    expect(parse('11 execve("./helper", ["helper"], 0x2 /* 1 vars */) = 0').error).toContain(
      "relative path",
    );
  });

  it("fails closed on truncation, unpaired lines and a foreign first exec", () => {
    expect(
      parse('11 execve("/bin/sh", ["sh", "-c", "aaaa"...], 0x2 /* 1 vars */) = 0').error,
    ).toContain("truncated");
    expect(parse('11 execve("/bin/sh", ["sh", "-c", ...], 0x2 /* 1 vars */) = 0').error).toContain(
      "truncated",
    );
    expect(parse("11 <... execve resumed>) = 0").error).toContain("resumed without its start");
    expect(parse('11 execve("/bin/sh", ["sh"], 0x2 /* 1 vars */ <unfinished ...>').error).toContain(
      "never finished",
    );
    expect(parseTrace('10 execve("/bin/sh", ["sh"], 0x1) = 0', CODEX, []).error).toContain(
      "not the traced command",
    );
  });
});

describe("strace network record", () => {
  it("records unix client connects, labels only the listed addresses and keeps others literal", () => {
    const trace = parse(
      '11 connect(23<UNIX-STREAM:[901]>, {sa_family=AF_UNIX, sun_path="/srv/op/.codex/app-server-control/app-server-control.sock"}, 110) = 0',
      '11 connect(25<TCP:[902]>, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 EINPROGRESS (Operation now in progress)',
      '11 connect(26<TCP:[903]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("104.18.32.47")}, 16) = -1 EINPROGRESS (Operation now in progress)',
      '11 sendmsg(24<UDP:[0.0.0.0:46426]>, {msg_name={sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("10.0.0.2")}, msg_namelen=16, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, 0) = 1',
      '11 sendto(27<TCP:[127.0.0.1:5000->127.0.0.1:8080]>, "GET / HTTP/1.1", 14, MSG_NOSIGNAL, NULL, 0) = 14',
    );
    expect(trace.error).toBeNull();
    expect(trace.net).toEqual(
      [
        JSON.stringify([
          "connect",
          "unix-stream",
          "/srv/op/.codex/app-server-control/app-server-control.sock",
        ]),
        JSON.stringify(["connect", "tcp", "<loopback>"]),
        JSON.stringify(["connect", "tcp", "104.18.32.47:443"]),
        JSON.stringify(["send", "udp", "10.0.0.2:53"]),
        JSON.stringify(["send", "tcp", "<loopback>"]),
      ].sort(),
    );
  });

  it("cannot be fooled by a payload that looks like an address", () => {
    const trace = parse(
      '11 sendto(27<TCP:[127.0.0.1:5000->93.184.216.34:80]>, "{sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr(\\"127.0.0.1\\")}", 70, 0, NULL, 0) = 70',
    );
    expect(trace.net).toEqual([JSON.stringify(["send", "tcp", "93.184.216.34:80"])]);
  });

  it("separates socketpair traffic inside the tree from connected unix peers", () => {
    const trace = parse(
      "11 socketpair(AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC, 0, [28<UNIX-STREAM:[500->501]>, 29<UNIX-STREAM:[501->500]>]) = 0",
      '11 sendmsg(28<UNIX-STREAM:[500->501]>, {msg_name=NULL, msg_namelen=0, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, MSG_NOSIGNAL) = 1',
      '11 connect(30<UNIX-STREAM:[600]>, {sa_family=AF_UNIX, sun_path="/run/daemon.sock"}, 110) = 0',
      '11 sendmsg(30<UNIX-STREAM:[600->601]>, {msg_name=NULL, msg_namelen=0, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, MSG_NOSIGNAL) = 1',
    );
    expect(trace.internal).toEqual([JSON.stringify(["send", "unix-stream", "socketpair"])]);
    expect(trace.net).toEqual([
      JSON.stringify(["connect", "unix-stream", "/run/daemon.sock"]),
      JSON.stringify(["send", "unix-stream", "/run/daemon.sock"]),
    ]);
  });
});

describe("strace file record", () => {
  it("keeps write-intent operations with resolved paths and skips reads", () => {
    const trace = parse(
      '11 openat(AT_FDCWD</tmp/probe-x/cwd>, "notes.txt", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0666) = 5</tmp/probe-x/cwd/notes.txt>',
      '11 openat(AT_FDCWD</tmp/probe-x/cwd>, "/etc/hosts", O_RDONLY|O_CLOEXEC) = 6</etc/hosts>',
      '11 rename("/tmp/probe-x/chome/.tmpAb12Cd", "/tmp/probe-x/chome/.sandbox_migration") = 0',
      '11 unlinkat(7</tmp/probe-x/chome>, "new-secret.txt", 0) = 0',
      '11 openat(AT_FDCWD</>, "/proc/4242/uid_map", O_WRONLY) = 8</proc/4242/uid_map>',
      '11 mkdir("/tmp/probe-x/chome/tmp/arg0/codex-arg0Zz9Yy8", 0700) = 0',
    );
    expect(trace.error).toBeNull();
    expect(trace.files).toEqual(
      [
        JSON.stringify(["write", "<probe>/cwd/notes.txt"]),
        JSON.stringify(["rename", "<probe>/chome/.tmp<tmp>", "<probe>/chome/.sandbox_migration"]),
        JSON.stringify(["unlink", "<probe>/chome/new-secret.txt"]),
        JSON.stringify(["write", "/proc/<pid>/uid_map"]),
        JSON.stringify(["mkdir", "<probe>/chome/tmp/arg0/codex-arg0<tmp>"]),
      ].sort(),
    );
  });
});

describe("strace exclusive creation", () => {
  it("marks only a successful O_CREAT|O_EXCL open as a creation", () => {
    const trace = parse(
      '11 openat(AT_FDCWD</>, "/var/tmp/etilqs_0123456789abcdef", O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600) = 9</var/tmp/etilqs_0123456789abcdef>',
      '11 openat(AT_FDCWD</>, "/srv/op/.bashrc", O_RDWR|O_CREAT|O_EXCL, 0600) = -1 EEXIST (File exists)',
    );
    expect(trace.files).toEqual([
      JSON.stringify(["create", "/var/tmp/etilqs_0123456789abcdef"]),
      JSON.stringify(["write", "/srv/op/.bashrc"]),
    ]);
  });
});

describe("strace command", () => {
  it("follows forks, prints descriptor paths, keeps full strings and kills tracees if strace dies", () => {
    const command = tracedCommand("/usr/bin/strace", "/tmp/t.txt", "/bin/codex", ["app-server"]);
    expect(command.file).toBe("/usr/bin/strace");
    expect(command.args).toEqual(expect.arrayContaining(["-f", "-yy", "--kill-on-exit"]));
    const traced = command.args[command.args.indexOf("-e") + 1]!.replace("trace=", "").split(",");
    expect(traced).toEqual(
      expect.arrayContaining([
        "execve",
        "execveat",
        "connect",
        "sendto",
        "sendmsg",
        "bind",
        "openat",
      ]),
    );
    expect(Number(command.args[command.args.indexOf("-s") + 1])).toBeGreaterThanOrEqual(65_536);
    expect(command.args.slice(-3)).toEqual(["--", "/bin/codex", "app-server"]);
  });
});

describe("strace record details the exemptions rely on", () => {
  const withCwd = (...lines: string[]) =>
    parseTrace([root, ...lines].join("\n"), CODEX, REWRITES, new Map(), "/tmp/probe-x/cwd");

  it("records each file operation in order, whether it succeeded and the path the kernel opened", () => {
    const trace = withCwd(
      '11 openat(AT_FDCWD</tmp/probe-x/cwd>, "/var/tmp/etilqs_0123456789abcdef", O_RDWR|O_CREAT|O_EXCL, 0600) = 7</var/tmp/etilqs_0123456789abcdef>',
      '11 unlink("/var/tmp/etilqs_0123456789abcdef") = -1 EPERM (Operation not permitted)',
      '11 openat(AT_FDCWD</tmp/probe-x/cwd>, "/tmp/probe-x/chome/logs_2.sqlite-wal", O_RDWR|O_CREAT, 0644) = 8</srv/op/notes.txt>',
    );
    expect(trace.error).toBeNull();
    expect(trace.fileLog).toEqual([
      {
        op: "create",
        paths: ["/var/tmp/etilqs_0123456789abcdef"],
        ok: true,
        resolved: "/var/tmp/etilqs_0123456789abcdef",
      },
      { op: "unlink", paths: ["/var/tmp/etilqs_0123456789abcdef"], ok: false },
      {
        op: "write",
        paths: ["<probe>/chome/logs_2.sqlite-wal"],
        ok: true,
        resolved: "/srv/op/notes.txt",
      },
    ]);
  });

  it("fails a relative file path whose directory is unknown, as it does for an exec", () => {
    const trace = parseTrace(
      [root, '11 open("notes.txt", O_WRONLY|O_CREAT, 0644) = 5</elsewhere/notes.txt>'].join("\n"),
      CODEX,
      REWRITES,
    );
    expect(trace.error).toContain("relative to an unknown directory");
  });

  it("resolves a relative path against the tracked working directory, inherited across clone", () => {
    const trace = withCwd(
      "10 clone(child_stack=NULL, flags=CLONE_NEWNS|SIGCHLD) = 12",
      '12 chdir("/tmp") = 0',
      '12 mkdir("newroot", 0755) = 0',
      '10 open("notes.txt", O_WRONLY|O_CREAT, 0644) = 5</tmp/probe-x/cwd/notes.txt>',
    );
    expect(trace.error).toBeNull();
    expect(trace.fileLog.map((event) => event.paths[0])).toEqual([
      "/tmp/newroot",
      "<probe>/cwd/notes.txt",
    ]);
  });

  it("counts io_uring setup, whose operations strace cannot see", () => {
    expect(withCwd("11 io_uring_setup(8, 0x7ffd1234) = 5").ioUring).toBe(1);
    expect(withCwd().ioUring).toBe(0);
  });
});
