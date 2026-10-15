import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { joinPathArityViolations } from './ps1-helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'packages/web/public/install.ps1');
const text = (): string => readFileSync(SCRIPT, 'utf-8');

// Text assertions only: this script can only really run on Windows (on-machine e2e is planned Task 9 Step 4).
// What we pin are the points "you cannot see by reading the code; a mistake only blows up on the user's machine".
describe('install.ps1', () => {
  it('exists and is shipped by the web build', () => {
    assert.equal(existsSync(SCRIPT), true);
    // Source of truth has moved into FILES in `scripts/copy-web-public.ts` (the `build` script's
    // old POSIX `mkdir -p && cp && rm -rf` chain cannot run on Windows; see that script's header).
    // When changing assertions, watch the **new source of truth**, not package.json strings.
    const pkg = readFileSync(join(ROOT, 'packages/web/package.json'), 'utf-8');
    assert.match(pkg, /copy-web-public/, 'build 必须调用那个跨平台拷贝脚本');
    const copier = readFileSync(join(ROOT, 'scripts/copy-web-public.ts'), 'utf-8');
    assert.match(copier, /'install\.ps1'/);
  });

  // Measured (PS 5.1, same body fed three Content-Types):
  //   octet-stream   -> irm|iex runs, but the body is **decoded as Latin-1**, non-ASCII becomes mojibake
  //   text/plain     -> same (no charset)
  //   charset=utf-8  -> fine
  // The server is ours (Fastify + a hand-written trySendFile MIME table, see packages/server/src/http.ts),
  // and **already** serves `.ps1` as `text/plain; charset=utf-8` (added this round), so Chinese would work.
  // The remaining reason to insist on ASCII: the script may still come from a static host / a proxy
  // that rewrites Content-Type, and the installer must not print mojibake at **the moment of failure**
  // — ASCII is correct on every delivery path.
  // (install.sh is unaffected: curl passes bytes, the shell does not decode.)
  it('keeps the body ASCII so `irm | iex` cannot mojibake its messages', () => {
    assert.doesNotMatch(text(), /[^\x00-\x7F]/, 'install.ps1 必须纯 ASCII');
  });

  it('only targets Windows x64 (a 32-bit shell on x64 must not be rejected)', () => {
    const src = text();
    assert.match(src, /PROCESSOR_ARCHITECTURE/);
    // 32-bit PowerShell on a 64-bit system reports x86 — looking only at PROCESSOR_ARCHITECTURE would reject a real x64 machine
    assert.match(src, /PROCESSOR_ARCHITEW6432/);
    assert.match(src, /AMD64/);
    assert.match(src, /win32-x64/);
    assert.match(src, /ARM64/);
    assert.match(src, /Unsupported/);
  });

  // This script is written for Windows PowerShell 5.1 (the scheduled task always uses it)
  it('avoids PowerShell 7 only syntax', () => {
    const src = text();
    assert.doesNotMatch(src, /&&/, '5.1 没有 &&');
    assert.doesNotMatch(src, /\?\?/, '5.1 没有 ??');
    assert.doesNotMatch(src, /\?\./, '5.1 没有 ?.');
    // Line-by-line + quote/paren aware: `\s` false-positives across lines, and the space in `'CodeBuddy CN\x'` is not a parameter separator
    assert.deepEqual(joinPathArityViolations(src), [], '5.1 的 Join-Path 只吃两个位置参数');
  });

  it('downloads fast and writes bytes, not UTF-16 text', () => {
    const src = text();
    // 5.1's progress bar makes Invoke-WebRequest 10× slower
    assert.match(src, /\$ProgressPreference\s*=\s*'SilentlyContinue'/);
    assert.match(src, /-UseBasicParsing/);
    assert.match(src, /-OutFile/);
    assert.doesNotMatch(src, /Out-File/, '5.1 的 Out-File 默认 UTF-16，会把二进制写坏');
  });

  it('verifies sha256 and refuses to touch the old runtime on mismatch', () => {
    const src = text();
    assert.match(src, /Get-FileHash/);
    assert.match(src, /SHA256/);
    // Validate sidecar shape first: login-page HTML posing as sha256 must report "intercepted by login page", not be compared as a hash
    assert.match(src, /\[a-f0-9\]\{64\}/);
    assert.match(src, /login page/);
    assert.match(src, /sha256 mismatch/);
    assert.match(src, /left untouched/);
  });

  // PATH is not a safe way to find it: Git-for-Windows / MSYS ships GNU tar, which reads
  // `C:\...zip` as a remote host ("Cannot connect to C: resolve failed") and cannot open zip
  // at all. Measured 2026-10-12: `lifeline update` started from Git Bash failed to extract the
  // runtime zip, rolled back, and stayed on the old version. Only Windows' own tar may be used,
  // and only by absolute path.
  it('uses the bundled tar.exe by absolute path, never a tar from PATH', () => {
    const src = text();
    assert.doesNotMatch(src, /Get-Command\s+tar/, '解压不能用 PATH 解析（Get-Command tar）');
    // Text presence is not the behaviour. Pin the **call** and the **branch**: reviewing this
    // test (2026-10-12) showed that assertions on the strings above alone stayed green under two
    // mutations — `& tar.exe -xf` (the PATH regression itself) and `if ($false)` (tar never runs,
    // every machine silently downgraded to Expand-Archive).
    assert.match(src, /&\s+\$tarExe\s+-xf/, '必须用解析出来的绝对路径调用');
    assert.doesNotMatch(src, /(^|\s)&\s*tar(\.exe)?\s/m, '不许再按名字调用 tar');
    assert.match(src, /\$env:SystemRoot/, 'Windows 自带的 tar.exe 要用 %SystemRoot% 定位');
    assert.match(src, /System32\\tar\.exe/, '必须是 System32 下的那一个');
    // Win10 before 1803 has no tar.exe — a fallback is required, and it **must use -LiteralPath**
    assert.match(
      src,
      /if\s*\(\s*\$tarExe\s*\)\s*\{[\s\S]{0,400}?&\s+\$tarExe\s+-xf[\s\S]{0,400}?\}\s*else\s*\{[\s\S]{0,400}?Expand-Archive\s+-LiteralPath[^\n]*-DestinationPath/,
      'tar 分支由 $tarExe 决定，回落仍是 Expand-Archive -LiteralPath',
    );
    assert.doesNotMatch(src, /Expand-Archive\s+-Path/, '-Path 会把 [] 当通配符');
    assert.match(src, /node\.exe/);
    assert.match(src, /lifeline\.mjs/);
    assert.match(src, /runtime\.next/);
  });

  // A native command's failure only sets $LASTEXITCODE -- it does not throw, not even under
  // $ErrorActionPreference 'Stop' (measured 2026-10-12). Without this check a half-written
  // runtime.next rides on the two sentinel files below and can be swapped in. install.sh guards
  // its tar call the same way (`if ! tar -xJf …; then`).
  it('refuses the install when tar exits non-zero', () => {
    const src = text();
    assert.match(
      src,
      /&\s+\$tarExe\s+-xf[^\n]*\n\s*if\s*\(\s*\$LASTEXITCODE\s+-ne\s+0\s*\)\s*\{[\s\S]{0,120}?Fail\s+'Extraction failed/,
      'tar 的退出码必须检查，否则半解压的 runtime 可能被换上',
    );
  });

  // A running node.exe cannot be deleted on Windows (Access denied) — must rename around it
  it('replaces the runtime by rename, never by deleting a locked node.exe', () => {
    const src = text();
    assert.match(src, /runtime\.old/);
    assert.match(src, /Rename-Item/);
    assert.doesNotMatch(
      src,
      /Remove-Item[^\n]*\$runtimeDir[^\n]*\n[^\n]*Move-Item/,
      '不许"先删 runtime 再搬 runtime.next"',
    );
  });

  it('stops the daemon before swapping and starts it again afterwards', () => {
    const src = text();
    assert.match(src, /Stop-ScheduledTask/);
    assert.match(src, /Start-ScheduledTask/);
    assert.match(src, /Lifeline Agent/);
  });

  // The order itself is the file-lock scheme: stop the daemon before renaming, rename before
  // moving the new tree in, restart only after the move. Wrong order leaves a half-state of
  // "runtime gone, CLI dangling".
  it('keeps the swap ordering invariant: stop < rename < move < start', () => {
    const src = text();
    const at = (re: RegExp, what: string): number => {
      const m = re.exec(src);
      assert.ok(m, `missing ${what}`);
      return m.index;
    };
    const stop = at(/^\s*Stop-DaemonQuiet\s*$/m, 'Stop-DaemonQuiet call');
    const rename = at(/Rename-Item\s+-LiteralPath\s+\$runtimeDir/, 'rename of the live runtime');
    const move = at(/Move-Item\s+-LiteralPath\s+\$nextDir/, 'move of runtime.next');
    const start = at(/^\s*Start-DaemonQuiet\s*$/m, 'Start-DaemonQuiet call');
    assert.ok(stop < rename, '要先停守护，再给正在跑的 IDE/runtime 改名');
    assert.ok(rename < move, '要先腾位置，再把 runtime.next 搬进来');
    assert.ok(move < start, '搬完才重启守护');
  });

  // A locked .old that cannot be deleted is moved to runtime.old.<stamp>; not sweeping those adds a full runtime on every upgrade
  it('sweeps every runtime.old* leftover so a locked one cannot accumulate', () => {
    const src = text();
    assert.match(src, /-Filter\s+'runtime\.old\*'/);
    assert.match(src, /Get-ChildItem\s+-LiteralPath\s+\$libDir/);
  });

  it('can roll the swap back instead of leaving the CLI dangling', () => {
    const src = text();
    assert.match(src, /Rename-Item\s+-LiteralPath\s+\$oldDir\s+-NewName\s+'runtime'/);
  });

  it('writes a %~dp0-relative lifeline.cmd shim in ASCII', () => {
    const src = text();
    assert.match(src, /lifeline\.cmd/);
    assert.match(src, /%~dp0/);
    assert.match(src, /-Encoding ASCII/);
  });

  // User PATH read/write: the one thing most likely to wreck someone else's environment is writing the User slot
  it('only touches the User PATH, and never deletes the variable', () => {
    const src = text();
    assert.match(src, /GetEnvironmentVariable\('Path',\s*'User'\)/);
    assert.match(src, /SetEnvironmentVariable\('Path'[^\n]*'User'\)/);
    assert.doesNotMatch(src, /SetEnvironmentVariable\([^)]*,\s*\$null\)/, '传 $null 是删变量');
    // Must not write $env:Path (User+Machine concatenated) back into the User slot
    assert.doesNotMatch(src, /SetEnvironmentVariable\('Path',\s*\$env:Path/);
  });

  it('starts the new shim on upgrade and does not hint a daemon install', () => {
    const src = text();
    assert.match(src, /Updated:/);
    assert.doesNotMatch(src, /lifeline daemon install/);
    assert.match(src, /lifeline setup --server-url/);
    assert.match(src, /uninstall\.ps1/);
    assert.match(src, /PowerShell/);
    const pathUpdate = src.indexOf('$env:Path = $env:Path');
    const startAt = src.search(/& \$shimPath start/);
    assert.ok(pathUpdate >= 0, 'session PATH update');
    assert.ok(startAt > pathUpdate, 'start runs after the session PATH is updated');
    const shimAssign = src.indexOf('$shimPath = Join-Path $binDir \'lifeline.cmd\'');
    assert.ok(shimAssign >= 0 && shimAssign < startAt, 'start uses the shim under $binDir');
    const upgrade = src.slice(src.indexOf('if ($wasInstalled)'));
    assert.match(src, /\$wasInstalled = \(Test-Path -LiteralPath \$mjsPath\) -and \(Test-Path -LiteralPath \$configPath\)/);
    assert.match(upgrade, /Remove-Item Env:LIFELINE_SUPERVISED/);
    assert.match(upgrade, /Remove-Item Env:INVOCATION_ID/);
    assert.match(upgrade, /& \$shimPath start/);
    const startFail = upgrade.match(/& \$shimPath start[\s\S]{0,500}/);
    assert.ok(startFail, 'upgrade path must invoke the shim');
    assert.match(startFail[0], /\$LASTEXITCODE -ne 0[\s\S]*?Fail /);
    assert.doesNotMatch(startFail[0], /left in place/);
    assert.match(startFail[0], /run this command again/);
    // Rollback still restarts the previous task. The success path must not.
    assert.equal((src.match(/^\s*Start-DaemonQuiet\s*$/gm) ?? []).length, 2);
    const catchAt = src.indexOf('} catch {');
    const firstQuiet = src.search(/^\s*Start-DaemonQuiet\s*$/m);
    assert.ok(catchAt >= 0 && firstQuiet > catchAt, 'Start-DaemonQuiet stays on the rollback path');
  });

  it('does not claim the previous runtime survived a failed start after the swap', () => {
    const src = text();
    const branch = src.match(/if \(\$script:swapped\) \{[\s\S]*?\n {2}\}/);
    assert.ok(branch, 'post-swap failure has its own throw');
    assert.doesNotMatch(branch[0], /left in place/);
    assert.match(branch[0], /run this command again/);
    assert.match(src, /throw 'lifeline install did not complete -- the existing runtime was left in place'/);
  });

  it('does not leak $ErrorActionPreference into the caller session (irm | iex runs in-session)', () => {
    const src = text();
    // The whole body is wrapped in a function: `$ErrorActionPreference = 'Stop'` is **function-scoped** and will not pollute the user session
    assert.match(src, /^function\s+\S+\s*\{/m);
    assert.match(src, /\$ErrorActionPreference\s*=\s*'Stop'/);
    assert.doesNotMatch(src, /^\s*exit\s/m, 'iex 里的 exit 会把用户的 PowerShell 窗口关掉');
  });

  it('does not contain any token or credential', () => {
    assert.doesNotMatch(text(), /AGENT_TOKEN|agentToken|Bearer /);
  });

  /**
   * `lifeline update` feeds this script to `powershell -Command -`: that mode executes stdin
   * **statement by statement**, so a throw inside `Install-Lifeline` only aborts that one
   * statement, then the following cleanup succeeds and **washes the process exit code to 0**
   * (measured: install failed but status=0). This trailing re-throw is the only way to make
   * the exit code honest — cannot use `exit` (`irm | iex` would close the user's PowerShell window).
   */
  it('re-raises failure at the very end so the exit code stays honest', () => {
    const src = text();
    assert.match(src, /\$installFailed = \$false/);
    assert.match(src, /if \(\$installFailed\) \{/);
    assert.match(src, /throw 'lifeline install did not complete/);
    // No further statement after the end may rewrite the exit code
    assert.equal(src.trimEnd().endsWith('}'), true, 're-throw 必须是最后一条语句');
  });
});
