#!/usr/bin/env python3
"""Drive an interactive `claude` in a pty (no tmux needed).
usage: pty_drive.py <cwd> <seconds-wait-first-screen> <prompt-or-empty> <claude args...>
Prints the raw screen text (ANSI stripped). Never answers a trust dialog: aborts instead."""
import os, pty, re, select, sys, time, signal
cwd, first, prompt, *args = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.execvp('claude', ['claude', *args])
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 180, 0, 0))
buf = b''
def pump(t):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.3)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: return
            if not d: return
            buf += d
pump(float(first))
txt = re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07', b'', buf).decode('utf8', 'replace')
if re.search(r'trust this folder|Do you trust', txt, re.I):
    print('TRUST-DIALOG: aborting (not answering)'); os.kill(pid, signal.SIGKILL); sys.exit(3)
if prompt:
    os.write(fd, prompt.encode()); time.sleep(0.5); os.write(fd, b'\r')
    pump(float(os.environ.get('ODD_WAIT', '40')))
txt = re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07', b'', buf).decode('utf8', 'replace')
print(txt[-6000:])
os.kill(pid, signal.SIGKILL)
