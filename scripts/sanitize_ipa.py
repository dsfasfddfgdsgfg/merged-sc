import argparse, os, plistlib, re, shutil, struct, subprocess, sys, tempfile

DYLIB_CMDS = {0x0C: 'LOAD_DYLIB', 0x80000018: 'LOAD_WEAK_DYLIB', 0x8000001F: 'REEXPORT_DYLIB',
              0x20: 'LAZY_LOAD_DYLIB', 0x80000023: 'LOAD_UPWARD_DYLIB'}
LC_RPATH = 0x8000001C

DENY = re.compile(r'(substrate|ellekit|substitute|libhooker|cydia|frida|scmusicplus|sideload|cephei|rocketbootstrap|'
                  r'libsparkapplist|libcolorpicker|tweakinject|injectdylib|dobby|fishhook)', re.I)
KEEP_LOOSE = re.compile(r'^(libswift|libclang_rt|libc\+\+|libobjc|libsystem)', re.I)


def is_system(path):
    return path.startswith('/usr/lib/') or path.startswith('/System/') or path.startswith('/usr/')


def macho_slices(buf):
    """Список (offset) 64-битных little-endian slice'ов в файле (thin или fat)."""
    if len(buf) < 8:
        return []
    magic_be = struct.unpack_from('>I', buf, 0)[0]
    if magic_be in (0xCAFEBABE, 0xCAFEBABF):
        n = struct.unpack_from('>I', buf, 4)[0]
        res = []
        for i in range(n):
            if magic_be == 0xCAFEBABE:
                _, _, off, size, _ = struct.unpack_from('>iiIII', buf, 8 + 20 * i)
            else:
                _, _, off, size, _, _ = struct.unpack_from('>iiQQII', buf, 8 + 32 * i)
            res.append(off)
        return [o for o in res if struct.unpack_from('<I', buf, o)[0] == 0xFEEDFACF]
    if struct.unpack_from('<I', buf, 0)[0] == 0xFEEDFACF:
        return [0]
    return []


def load_commands(buf, off):
    ncmds, sizeofcmds = struct.unpack_from('<II', buf, off + 16)
    p = off + 32
    cmds = []
    for _ in range(ncmds):
        cmd, size = struct.unpack_from('<II', buf, p)
        cmds.append((cmd, size, p))
        p += size
    return ncmds, sizeofcmds, cmds


def dylib_path(buf, cmd_pos, size):
    name_off = struct.unpack_from('<I', buf, cmd_pos + 8)[0]
    return bytes(buf[cmd_pos + name_off:cmd_pos + size]).split(b'\0')[0].decode('utf8', 'replace')


def list_dylibs(buf):
    out = []
    for off in macho_slices(buf)[:1]:
        _, _, cmds = load_commands(buf, off)
        for cmd, size, pos in cmds:
            if cmd in DYLIB_CMDS:
                out.append((DYLIB_CMDS[cmd], dylib_path(buf, pos, size)))
            elif cmd == LC_RPATH:
                out.append(('RPATH', dylib_path(buf, pos, size)))
    return out


def strip_dylibs(buf, should_remove):
    """Вырезает dylib load-команды, для которых should_remove(path) истинно. Возвращает список удалённых путей."""
    removed_all = []
    for off in macho_slices(buf):
        ncmds, sizeofcmds, cmds = load_commands(buf, off)
        kept = bytearray()
        removed = []
        for cmd, size, pos in cmds:
            if cmd in DYLIB_CMDS:
                path = dylib_path(buf, pos, size)
                if should_remove(path):
                    removed.append(path)
                    continue
            kept += buf[pos:pos + size]
        if removed:
            start = off + 32
            buf[start:start + sizeofcmds] = bytes(kept) + b'\0' * (sizeofcmds - len(kept))
            struct.pack_into('<II', buf, off + 16, ncmds - len(removed), len(kept))
            removed_all += removed
    return removed_all


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--strict', action='store_true', help='удалять любые лишние *.dylib, не только известные tweak-библиотеки')
    ap.add_argument('--report', default='sanitize-report.md')
    a = ap.parse_args()

    work = tempfile.mkdtemp(prefix='sanitize_')
    subprocess.check_call(['unzip', '-q', a.src, '-d', work])
    payload = os.path.join(work, 'Payload')
    apps = [d for d in os.listdir(payload) if d.endswith('.app')]
    if not apps:
        sys.exit('::error::В IPA нет Payload/*.app')
    app = os.path.join(payload, apps[0])
    with open(os.path.join(app, 'Info.plist'), 'rb') as f:
        info = plistlib.load(f)
    exe_name = info['CFBundleExecutable']
    exe = os.path.join(app, exe_name)
    rep = ['## Очистка базового IPA', '',
           f"- bundle id: `{info.get('CFBundleIdentifier')}`, версия: `{info.get('CFBundleShortVersionString')}` ({info.get('CFBundleVersion')})",
           f"- режим: {'strict (удаляются любые лишние dylib)' if a.strict else 'обычный (только известные tweak-библиотеки)'}", '']

    fw_dir = os.path.join(app, 'Frameworks')
    removed_files = []   # basenames удалённых файлов/папок

    def rm(path):
        rel = os.path.relpath(path, app)
        shutil.rmtree(path) if os.path.isdir(path) and not os.path.islink(path) else os.remove(path)
        removed_files.append(os.path.basename(path))
        rep.append(f'- удалено: `{rel}`')

    rep.append('### Удалённые файлы')
    n_before = len(rep)
    scan_dirs = [app] + ([fw_dir] if os.path.isdir(fw_dir) else [])
    for d in scan_dirs:
        for name in sorted(os.listdir(d)):
            path = os.path.join(d, name)
            low = name.lower()
            if low.endswith('.dylib'):
                if DENY.search(name) or (a.strict and not KEEP_LOOSE.match(name)):
                    rm(path)
            elif low.endswith('.framework') and d == fw_dir:
                if DENY.search(name):
                    rm(path)
            elif low.endswith('.bundle') and DENY.search(name):
                rm(path)
    if len(rep) == n_before:
        rep.append('- ничего')
    rep.append('')

    with open(exe, 'rb') as f:
        buf = bytearray(f.read())
    rep.append('### Load-команды главного бинарника ДО')
    before = list_dylibs(buf)
    for kind, p in before:
        rep.append(f'- {kind}: `{p}`')
    rep.append('')

    def exists_in_bundle(path):
        m = re.match(r'@(?:rpath|executable_path|loader_path)/(.+)', path)
        if not m:
            return True
        rel = m.group(1)
        return any(os.path.exists(os.path.join(base, rel)) for base in (fw_dir, app))

    def should_remove(path):
        base = os.path.basename(path)
        if DENY.search(path):          # проверяем раньше is_system: бывают ссылки вида /usr/lib/libsubstrate.dylib
            return True
        if is_system(path):
            return False
        if base in removed_files or any(('/' + r + '/') in path for r in removed_files):
            return True
        if base.startswith('libswift') or base.startswith('libclang_rt'):
            return False
        return not exists_in_bundle(path)   # «висячая» ссылка — dyld всё равно не запустит приложение

    removed_cmds = strip_dylibs(buf, should_remove)
    if removed_cmds:
        with open(exe, 'wb') as f:
            f.write(buf)
        os.chmod(exe, 0o755)
    rep.append('### Вырезанные load-команды')
    rep += [f'- `{p}`' for p in removed_cmds] or ['- ничего']
    rep.append('')
    rep.append('### Остальное, что осталось в базе (для справки)')
    extra = []
    for d in scan_dirs:
        for name in sorted(os.listdir(d)):
            if name.lower().endswith('.dylib') and not KEEP_LOOSE.match(name):
                extra.append(os.path.relpath(os.path.join(d, name), app))
    rep += [f'- loose dylib: `{e}`' for e in extra] or ['- посторонних loose dylib нет']

    if os.path.exists(a.dst):
        os.remove(a.dst)
    dst = os.path.abspath(a.dst)
    subprocess.check_call(['zip', '-qry', dst, 'Payload'], cwd=work)
    shutil.rmtree(work)
    with open(a.report, 'w', encoding='utf8') as f:
        f.write('\n'.join(rep) + '\n')
    print('\n'.join(rep))


if __name__ == '__main__':
    main()
