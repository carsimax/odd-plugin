# Tests for cds-skills install.ps1 / uninstall.ps1. Plain PowerShell (5.1 and 7), no Pester.
# Runs only against temp config dirs; never touches the real ~/.claude.
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$Install = Join-Path $Root 'install.ps1'
$Payload = Join-Path $Root 'payload'
$env:CDS_SRC = $Payload
Remove-Item Env:CDS_REF -ErrorAction SilentlyContinue

$PsExe = (Get-Process -Id $PID).Path
$Scratch = Join-Path ([IO.Path]::GetTempPath()) ("cds-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Scratch | Out-Null
$Utf8 = New-Object Text.UTF8Encoding $false
$script:Counter = 0

function Fail($m) {
  Write-Host "FAIL: $m"
  try { Remove-Item -Recurse -Force -LiteralPath $Scratch -ErrorAction SilentlyContinue } catch {}
  exit 1
}
function Assert-File($p) { if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail "missing file: $p" } }
function Assert-Absent($p) { if (Test-Path -LiteralPath $p) { Fail "should not exist: $p" } }
function Assert-Eq($got, $want, $msg) { if ("$got" -cne "$want") { Fail "${msg}: expected [$want] got [$got]" } }
function Read-Text($p) { $Utf8.GetString([IO.File]::ReadAllBytes($p)) }
function Write-Text($p, $s) { [IO.File]::WriteAllText($p, $s, $Utf8) }
function Count-Of($needle, $p) { ([regex]::Matches((Read-Text $p), [regex]::Escape($needle))).Count }
function Count-Glob($dir, $filter) {
  if (-not (Test-Path -LiteralPath $dir)) { return 0 }
  @(Get-ChildItem -LiteralPath $dir -Filter $filter).Count
}
function Bytes-Equal($a, $b) {
  $x = [IO.File]::ReadAllBytes($a); $y = [IO.File]::ReadAllBytes($b)
  if ($x.Length -ne $y.Length) { return $false }
  for ($i = 0; $i -lt $x.Length; $i++) { if ($x[$i] -ne $y[$i]) { return $false } }
  return $true
}

function New-Home {
  $script:Counter++
  $script:H = Join-Path $Scratch ("home" + $script:Counter)
  $script:T = Join-Path $script:H '.claude'
  New-Item -ItemType Directory -Path $script:T -Force | Out-Null
  $env:HOME = $script:H
  $env:USERPROFILE = $script:H
  Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
  $env:CLAUDE_CONFIG_DIR = $script:T
}
# Runs a script in a child shell; returns @{ Out; Code }.
function Run($script) {
  $out = & $PsExe -NoProfile -File $script *>&1 | Out-String
  @{ Out = $out; Code = $LASTEXITCODE }
}
function Run-Install { Run $Install }
function Run-Uninstall($t) { Run (Join-Path $t 'cds-skills\uninstall.ps1') }
function Get-Settings($p) { (Read-Text $p) | ConvertFrom-Json }

# ---------- install into a populated config ----------
New-Home
New-Item -ItemType Directory -Path (Join-Path $T 'agents'), (Join-Path $T 'skills\cds') -Force | Out-Null
Write-Text (Join-Path $T 'CLAUDE.md') "# My notes`nkeep me`n"
Write-Text (Join-Path $T 'agents\mine.md') 'user agent'
Write-Text (Join-Path $T 'skills\cds\leftover.txt') 'stale skill file'
Write-Text (Join-Path $T 'settings.json') "{`"theme`":`"dark`"}`n"

$r = Run-Install
if ($r.Code -ne 0) { Fail "install failed: $($r.Out)" }
Assert-Eq @(Get-ChildItem -LiteralPath (Join-Path $T 'skills') -Directory -Filter 'cds*').Count 13 'skill dirs'
foreach ($s in Get-ChildItem -LiteralPath (Join-Path $Payload 'skills') -Directory) {
  Assert-File (Join-Path $T "skills\$($s.Name)\SKILL.md")
}
Assert-Absent (Join-Path $T 'skills\cds\leftover.txt')
Assert-Eq (Count-Glob (Join-Path $T 'agents') 'cds-*.md') 10 'agents'
Assert-Eq (Count-Glob (Join-Path $T 'rules') 'cds-*.md') 3 'rules'
Assert-File (Join-Path $T 'output-styles\cds.md')
Assert-File (Join-Path $T 'cds-skills\uninstall.ps1')
Assert-File (Join-Path $T 'cds-skills\manifest.txt')
$manifest = @((Read-Text (Join-Path $T 'cds-skills\manifest.txt')) -split "`n" | Where-Object { $_ -ne '' })
Assert-Eq $manifest.Count 27 'manifest entries'
foreach ($e in 'skills/cds-branch-pr', 'agents/cds-worker.md', 'rules/cds-tracking.md', 'output-styles/cds.md') {
  if ($manifest -cnotcontains $e) { Fail "manifest lacks $e" }
}
Assert-File (Join-Path $T 'agents\mine.md')
# no BOM on written files
$b = [IO.File]::ReadAllBytes((Join-Path $T 'CLAUDE.md'))
if ($b[0] -eq 0xEF) { Fail 'CLAUDE.md written with BOM' }
$b = [IO.File]::ReadAllBytes((Join-Path $T 'settings.json'))
if ($b[0] -eq 0xEF) { Fail 'settings.json written with BOM' }

# CLAUDE.md: preserved + one block + backup
$claude = Join-Path $T 'CLAUDE.md'
if ((Read-Text $claude) -notmatch '(?m)^keep me\r?$') { Fail 'user CLAUDE.md content lost' }
Assert-Eq (Count-Of '<!-- cds:start -->' $claude) 1 'start markers'
Assert-Eq (Count-Of '<!-- cds:end -->' $claude) 1 'end markers'
$bk = @(Get-ChildItem -LiteralPath $T -Filter 'CLAUDE.md.cds-backup-*')
if ($bk.Count -lt 1) { Fail 'no CLAUDE.md backup' }
Assert-Eq (Read-Text $bk[0].FullName) "# My notes`nkeep me`n" 'backup content'
$expectCmd = "& `"$(Join-Path $T 'cds-skills\uninstall.ps1')`""
if (-not $r.Out.Contains($expectCmd)) { Fail "summary lacks uninstall command: $($r.Out)" }

$st = Get-Settings (Join-Path $T 'settings.json')
Assert-Eq $st.outputStyle 'cds' 'outputStyle'
Assert-Eq $st.theme 'dark' 'unrelated key'

# ---------- reinstall: no duplicate, stale removal, user edit outside block ----------
Add-Content -LiteralPath $claude -Value "`nuser tail" -Encoding ASCII
$mf = Join-Path $T 'cds-skills\manifest.txt'
Add-Content -LiteralPath $mf -Value 'agents/cds-old.md' -Encoding ASCII
Write-Text (Join-Path $T 'agents\cds-old.md') 'old'
Add-Content -LiteralPath $mf -Value '../escape.txt' -Encoding ASCII
Write-Text (Join-Path $H 'escape.txt') 'keep'
Add-Content -LiteralPath $mf -Value 'agents/other-user.md' -Encoding ASCII
Write-Text (Join-Path $T 'agents\other-user.md') 'mine'
$r = Run-Install
if ($r.Code -ne 0) { Fail "reinstall failed: $($r.Out)" }
Assert-Eq (Count-Of '<!-- cds:start -->' $claude) 1 'start markers after reinstall'
Assert-Eq (Count-Of '<!-- cds:end -->' $claude) 1 'end markers after reinstall'
if ((Read-Text $claude) -notmatch '(?m)^user tail\r?$') { Fail 'content after block lost' }
if ((Read-Text $claude) -notmatch '(?m)^keep me\r?$') { Fail 'content before block lost' }
Assert-Absent (Join-Path $T 'agents\cds-old.md')
Assert-File (Join-Path $T 'agents\mine.md')
Assert-File (Join-Path $T 'agents\other-user.md')
Assert-File (Join-Path $H 'escape.txt')
Assert-Eq @((Read-Text $mf) -split "`n" | Where-Object { $_ -ne '' }).Count 27 'manifest after reinstall'
Assert-Eq (Count-Glob $T 'CLAUDE.md.cds-backup-*') 2 'backups after reinstall'

# ---------- uninstall ----------
$r = Run-Uninstall $T
if ($r.Code -ne 0) { Fail "uninstall failed: $($r.Out)" }
Assert-Eq @(Get-ChildItem -LiteralPath (Join-Path $T 'skills') -Filter 'cds*' -ErrorAction SilentlyContinue).Count 0 'skills left'
Assert-Eq (Count-Glob (Join-Path $T 'agents') 'cds-*.md') 0 'agents left'
Assert-Eq (Count-Glob (Join-Path $T 'rules') 'cds-*.md') 0 'rules left'
Assert-Absent (Join-Path $T 'output-styles\cds.md')
Assert-Absent (Join-Path $T 'cds-skills')
Assert-File (Join-Path $T 'agents\mine.md')
Assert-File (Join-Path $T 'agents\other-user.md')
Assert-Eq (Count-Of 'cds:start' $claude) 0 'marker after uninstall'
if ((Read-Text $claude) -notmatch '(?m)^keep me\r?$') { Fail 'user content lost on uninstall' }
if ((Read-Text $claude) -notmatch '(?m)^user tail\r?$') { Fail 'user tail lost on uninstall' }
$st = Get-Settings (Join-Path $T 'settings.json')
Assert-Eq ($null -ne $st.PSObject.Properties['outputStyle']) $false 'outputStyle removed'
Assert-Eq $st.theme 'dark' 'unrelated key after uninstall'
# second uninstall (script copy kept outside) succeeds
Copy-Item -LiteralPath (Join-Path $Root 'uninstall.ps1') -Destination (Join-Path $Scratch 'uninstall.ps1')
$r = Run (Join-Path $Scratch 'uninstall.ps1')
if ($r.Code -ne 0) { Fail "second uninstall failed: $($r.Out)" }

# ---------- no-trailing-newline file round trip ----------
New-Home
Write-Text (Join-Path $T 'CLAUDE.md') "line one`nline two"
$r = Run-Install; if ($r.Code -ne 0) { Fail "install (no trailing newline): $($r.Out)" }
$r = Run-Uninstall $T; if ($r.Code -ne 0) { Fail "uninstall (no trailing newline): $($r.Out)" }
$got = Read-Text (Join-Path $T 'CLAUDE.md')
if ($got -cne "line one`nline two" -and $got -cne "line one`nline two`n") { Fail 'round trip altered CLAUDE.md' }

# ---------- fresh install: no CLAUDE.md, no settings.json ----------
New-Home
Remove-Item -Recurse -Force -LiteralPath $T
$r = Run-Install; if ($r.Code -ne 0) { Fail "fresh install: $($r.Out)" }
Assert-File (Join-Path $T 'CLAUDE.md')
Assert-Eq (Count-Of '<!-- cds:start -->' (Join-Path $T 'CLAUDE.md')) 1 'fresh start marker'
Assert-Eq (Get-Settings (Join-Path $T 'settings.json')).outputStyle 'cds' 'fresh outputStyle'

# ---------- invalid settings.json aborts without touching anything ----------
New-Home
Write-Text (Join-Path $T 'settings.json') '{not json'
$r = Run-Install
if ($r.Code -eq 0) { Fail 'install should abort on invalid settings.json' }
Assert-Eq (Read-Text (Join-Path $T 'settings.json')) '{not json' 'invalid settings untouched'
Assert-Absent (Join-Path $T 'skills')
Assert-Absent (Join-Path $T 'CLAUDE.md')
Assert-Absent (Join-Path $T 'cds-skills')

# ---------- uninstall keeps a non-cds outputStyle ----------
New-Home
$r = Run-Install; if ($r.Code -ne 0) { Fail "install: $($r.Out)" }
Write-Text (Join-Path $T 'settings.json') "{`"outputStyle`":`"other`"}`n"
$r = Run-Uninstall $T; if ($r.Code -ne 0) { Fail "uninstall: $($r.Out)" }
Assert-Eq (Get-Settings (Join-Path $T 'settings.json')).outputStyle 'other' 'foreign outputStyle kept'

# ---------- CLAUDE_CONFIG_DIR honored (HOME untouched) ----------
New-Home
$alt = Join-Path $Scratch 'alt-config'
$env:CLAUDE_CONFIG_DIR = $alt
$r = Run-Install; if ($r.Code -ne 0) { Fail "install with CLAUDE_CONFIG_DIR: $($r.Out)" }
Assert-File (Join-Path $alt 'agents\cds-worker.md')
Assert-File (Join-Path $alt 'cds-skills\manifest.txt')
Assert-Absent (Join-Path $T 'agents')
$r = Run-Uninstall $alt; if ($r.Code -ne 0) { Fail "uninstall with CLAUDE_CONFIG_DIR: $($r.Out)" }
Assert-Absent (Join-Path $alt 'agents\cds-worker.md')

# ---------- default target is $HOME\.claude when CLAUDE_CONFIG_DIR is unset ----------
New-Home
Remove-Item Env:CLAUDE_CONFIG_DIR
$r = Run-Install; if ($r.Code -ne 0) { Fail "install with default target: $($r.Out)" }
Assert-File (Join-Path $T 'agents\cds-worker.md')

# ---------- CRLF and plain CLAUDE.md round trip, byte-exact ----------
foreach ($variant in 'crlf', 'plain') {
  New-Home
  $orig = Join-Path $Scratch "orig.$variant"
  if ($variant -eq 'crlf') { Write-Text (Join-Path $T 'CLAUDE.md') "a`r`nb`r`n" } else { Write-Text (Join-Path $T 'CLAUDE.md') "# x`n`ny`n" }
  Copy-Item -LiteralPath (Join-Path $T 'CLAUDE.md') -Destination $orig
  $r = Run-Install; if ($r.Code -ne 0) { Fail "install 1 ($variant)" }
  $r = Run-Install; if ($r.Code -ne 0) { Fail "install 2 ($variant)" }
  Assert-Eq (Count-Of '<!-- cds:start -->' (Join-Path $T 'CLAUDE.md')) 1 "blocks ($variant)"
  $r = Run-Uninstall $T; if ($r.Code -ne 0) { Fail "uninstall ($variant)" }
  if (-not (Bytes-Equal (Join-Path $T 'CLAUDE.md') $orig)) { Fail "round trip not byte-exact ($variant)" }
}

# ---------- tampered manifest deletes nothing outside the allowlist ----------
New-Home
$r = Run-Install; if ($r.Code -ne 0) { Fail "install: $($r.Out)" }
New-Item -ItemType Directory -Path (Join-Path $T 'skills\cdsnotes-user') | Out-Null
Write-Text (Join-Path $T 'skills\cdsnotes-user\f') 'keep'
Write-Text (Join-Path $H 'victim') 'victim'
Write-Text (Join-Path $T 'settings.json') "{`"theme`":`"dark`"}`n"
$abs = Join-Path $H 'victim'
$tamper = @($abs, 'skills/cds/../../../victim', 'agents/../CLAUDE.md', 'settings.json', 'skills/cdsnotes-user', 'skills\cds-x\..\..\..\victim')
function Check-Tamper($when) {
  Assert-File (Join-Path $H 'victim'); Assert-File (Join-Path $T 'CLAUDE.md'); Assert-File (Join-Path $T 'settings.json')
  Assert-File (Join-Path $T 'skills\cdsnotes-user\f')
}
$mf = Join-Path $T 'cds-skills\manifest.txt'
Add-Content -LiteralPath $mf -Value $tamper -Encoding ASCII
$r = Run-Install; if ($r.Code -ne 0) { Fail "reinstall (tampered): $($r.Out)" }
Check-Tamper 'reinstall'
Add-Content -LiteralPath $mf -Value $tamper -Encoding ASCII
$r = Run-Uninstall $T; if ($r.Code -ne 0) { Fail "uninstall (tampered): $($r.Out)" }
Check-Tamper 'uninstall'

# ---------- symlinked CLAUDE.md and settings.json (write-through) ----------
New-Home
$dot = Join-Path $H 'dot'
New-Item -ItemType Directory -Path $dot | Out-Null
Write-Text (Join-Path $dot 'settings.json') "{`"theme`":`"dark`"}`n"
Write-Text (Join-Path $dot 'CLAUDE.md') 'mine'
$linked = $true
try {
  New-Item -ItemType SymbolicLink -Path (Join-Path $T 'settings.json') -Target (Join-Path $dot 'settings.json') -ErrorAction Stop | Out-Null
  New-Item -ItemType SymbolicLink -Path (Join-Path $T 'CLAUDE.md') -Target (Join-Path $dot 'CLAUDE.md') -ErrorAction Stop | Out-Null
} catch { $linked = $false }
if (-not $linked) {
  Write-Host 'SKIP: cannot create symlinks on this system, write-through assertions'
} else {
  function Is-Link($p) { [bool]((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
  $r = Run-Install; if ($r.Code -ne 0) { Fail "install with symlinks: $($r.Out)" }
  if (-not (Is-Link (Join-Path $T 'CLAUDE.md'))) { Fail 'CLAUDE.md symlink replaced on install' }
  if (-not (Is-Link (Join-Path $T 'settings.json'))) { Fail 'settings.json symlink replaced on install' }
  Assert-Eq (Count-Of '<!-- cds:start -->' (Join-Path $dot 'CLAUDE.md')) 1 'symlink target block'
  $st = Get-Settings (Join-Path $dot 'settings.json')
  Assert-Eq $st.outputStyle 'cds' 'symlink target outputStyle'
  Assert-Eq $st.theme 'dark' 'symlink target theme'
  $r = Run-Uninstall $T; if ($r.Code -ne 0) { Fail "uninstall with symlinks: $($r.Out)" }
  if (-not (Is-Link (Join-Path $T 'CLAUDE.md'))) { Fail 'CLAUDE.md symlink replaced on uninstall' }
  if (-not (Is-Link (Join-Path $T 'settings.json'))) { Fail 'settings.json symlink replaced on uninstall' }
  Assert-Eq (Read-Text (Join-Path $dot 'CLAUDE.md')).TrimEnd("`n") 'mine' 'symlink target CLAUDE.md restored'
  $st = Get-Settings (Join-Path $dot 'settings.json')
  Assert-Eq ($null -ne $st.PSObject.Properties['outputStyle']) $false 'symlink target outputStyle removed'
}

# ---------- piped form (Invoke-Expression) installs and keeps the session alive ----------
New-Home
$out = & $PsExe -NoProfile -Command "Get-Content -Raw '$Install' | Invoke-Expression; 'SESSION_ALIVE'" *>&1 | Out-String
if (-not $out.Contains('SESSION_ALIVE')) { Fail "piped install ended the session: $out" }
Assert-File (Join-Path $T 'agents\cds-worker.md')

# ---------- non-UTF-8 bytes in CLAUDE.md survive install and uninstall ----------
New-Home
$cp = [byte[]](0x63,0x61,0x66,0xE9,0x20,0x6E,0xF1,0x0A)
[IO.File]::WriteAllBytes((Join-Path $T 'CLAUDE.md'), $cp)
$orig = Join-Path $Scratch 'orig.cp1252'
[IO.File]::WriteAllBytes($orig, $cp)
$r = Run-Install; if ($r.Code -ne 0) { Fail "install (cp1252): $($r.Out)" }
$after = [IO.File]::ReadAllBytes((Join-Path $T 'CLAUDE.md'))
$head = @($after[0..7]) -join ','
Assert-Eq $head ($cp -join ',') 'cp1252 bytes intact after install'
$r = Run-Uninstall $T; if ($r.Code -ne 0) { Fail "uninstall (cp1252): $($r.Out)" }
if (-not (Bytes-Equal (Join-Path $T 'CLAUDE.md') $orig)) { Fail 'cp1252 round trip not byte-exact' }

# ---------- settings.json that is not a JSON object aborts with nothing written ----------
foreach ($bad in '', '   ', '[]', '"str"', 'null', '1') {
  New-Home
  Write-Text (Join-Path $T 'settings.json') $bad
  $r = Run-Install
  if ($r.Code -eq 0) { Fail "install should abort on settings.json [$bad]" }
  Assert-Eq (Read-Text (Join-Path $T 'settings.json')) $bad "settings untouched [$bad]"
  Assert-Absent (Join-Path $T 'skills'); Assert-Absent (Join-Path $T 'CLAUDE.md'); Assert-Absent (Join-Path $T 'cds-skills')
}

# ---------- more tampered manifest entries ----------
New-Home
$r = Run-Install; if ($r.Code -ne 0) { Fail "install: $($r.Out)" }
Write-Text (Join-Path $H 'v') 'victim'
New-Item -ItemType Directory -Path (Join-Path $T ' skills\cds') -Force | Out-Null
Write-Text (Join-Path $T ' skills\cds\f') 'keep'
$caseVictim = $false
if (-not (Test-Path -LiteralPath (Join-Path $T 'skills\CDS'))) {
  New-Item -ItemType Directory -Path (Join-Path $T 'skills\CDS') | Out-Null
  Write-Text (Join-Path $T 'skills\CDS\f') 'keep'
  $caseVictim = $true
}
$tamper2 = @('C:/v', 'C:v', 'skills/CDS', '../v', ' skills/cds')
$mf = Join-Path $T 'cds-skills\manifest.txt'
Add-Content -LiteralPath $mf -Value $tamper2 -Encoding ASCII
$r = Run-Install; if ($r.Code -ne 0) { Fail "reinstall (tampered 2): $($r.Out)" }
Add-Content -LiteralPath $mf -Value $tamper2 -Encoding ASCII
$r = Run-Uninstall $T; if ($r.Code -ne 0) { Fail "uninstall (tampered 2): $($r.Out)" }
Assert-File (Join-Path $H 'v')
Assert-File (Join-Path $T ' skills\cds\f')
if ($caseVictim) { Assert-File (Join-Path $T 'skills\CDS\f') }

# ---------- piped error path is catchable and keeps the session ----------
New-Home
$saved = $env:CDS_SRC
$env:CDS_SRC = Join-Path $Scratch 'missing-payload'
$out = & $PsExe -NoProfile -Command "try { Get-Content -Raw '$Install' | Invoke-Expression } catch { 'CAUGHT' }; 'SESSION_ALIVE'" *>&1 | Out-String
$env:CDS_SRC = $saved
if (-not $out.Contains('CAUGHT') -or -not $out.Contains('SESSION_ALIVE')) { Fail "piped error path: $out" }

# ---------- BOM-prefixed settings.json is accepted and rewritten without BOM ----------
New-Home
$bomBytes = [byte[]](0xEF,0xBB,0xBF) + [Text.Encoding]::ASCII.GetBytes('{"a":1}')
[IO.File]::WriteAllBytes((Join-Path $T 'settings.json'), $bomBytes)
$r = Run-Install; if ($r.Code -ne 0) { Fail "install with BOM settings: $($r.Out)" }
$st = Get-Settings (Join-Path $T 'settings.json')
Assert-Eq $st.a 1 'BOM settings key kept'
Assert-Eq $st.outputStyle 'cds' 'BOM settings outputStyle'
if ([IO.File]::ReadAllBytes((Join-Path $T 'settings.json'))[0] -eq 0xEF) { Fail 'settings.json rewritten with BOM' }

Remove-Item -Recurse -Force -LiteralPath $Scratch -ErrorAction SilentlyContinue
Write-Host 'PASS: all cds-skills install tests (ps1)'
