# cds-skills installer for Windows PowerShell 5.1 and PowerShell 7: skills, agents, rules, CLAUDE.md block and output style.
# Usage: irm https://raw.githubusercontent.com/carsimax/odd-plugin/main/cds-skills/install.ps1 | iex
# Env: CDS_REF (git ref, default main), CLAUDE_CONFIG_DIR (default $HOME\.claude),
#      CDS_SRC (local payload dir, skips download).
# Written to survive `| iex`: no param block, no exit; failures throw a clear message.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $Start = '<!-- cds:start -->'
  $End = '<!-- cds:end -->'
  $Utf8 = New-Object Text.UTF8Encoding $false

  # Only these target-relative paths may ever be removed by cds.
  function Test-Allowed($p) {
    if ([string]::IsNullOrEmpty($p)) { return $false }
    if ($p.StartsWith('/') -or $p.Contains('..') -or $p.Contains('\') -or $p.Contains(':')) { return $false }
    return ($p -ceq 'skills/cds') -or ($p -clike 'skills/cds-*') -or ($p -clike 'agents/cds-*.md') -or
      ($p -clike 'rules/cds-*.md') -or ($p -ceq 'output-styles/cds.md')
  }
  function Join-Rel($base, $rel) { Join-Path $base ($rel -replace '/', [IO.Path]::DirectorySeparatorChar) }
  function Read-Text($p) { $Utf8.GetString([IO.File]::ReadAllBytes($p)) }
  function Write-Text($p, $s) { [IO.File]::WriteAllText($p, $s, $Utf8) }
  # CLAUDE.md is handled as ISO-8859-1 (1 byte = 1 char) so bytes outside the block survive unchanged.
  $Latin1 = [Text.Encoding]::GetEncoding(28591)

  $T = $env:CLAUDE_CONFIG_DIR
  if ([string]::IsNullOrEmpty($T)) {
    $homeDir = $HOME
    if ([string]::IsNullOrEmpty($homeDir)) { $homeDir = $env:USERPROFILE }
    $T = Join-Path $homeDir '.claude'
  }
  $work = $null
  try {
    # ---- locate payload ----
    $P = $null; $UninstallSrc = $null
    if (-not [string]::IsNullOrEmpty($env:CDS_SRC)) {
      $P = $env:CDS_SRC
      $UninstallSrc = Join-Path (Split-Path -Parent $P) 'uninstall.ps1'
    } else {
      try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
      $ref = $env:CDS_REF
      if ([string]::IsNullOrEmpty($ref)) { $ref = 'main' }
      $work = Join-Path ([IO.Path]::GetTempPath()) ('cds-' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $work | Out-Null
      $url = "https://github.com/carsimax/odd-plugin/archive/$ref.zip"
      Write-Host "Downloading $url"
      $zip = Join-Path $work 'src.zip'
      try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip } catch { throw "download failed: $url ($($_.Exception.Message))" }
      $x = Join-Path $work 'x'
      Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
      foreach ($d in Get-ChildItem -LiteralPath $x -Directory) {
        $c = Join-Path $d.FullName 'cds-skills'
        if (Test-Path -LiteralPath (Join-Path $c 'payload') -PathType Container) {
          $P = Join-Path $c 'payload'; $UninstallSrc = Join-Path $c 'uninstall.ps1'
        }
      }
    }
    if (-not $P -or -not (Test-Path -LiteralPath (Join-Path $P 'CLAUDE.md') -PathType Leaf)) {
      throw "cds-skills payload not found (looked for $P); is the ref valid and the repo readable?"
    }
    if (-not (Test-Path -LiteralPath $UninstallSrc -PathType Leaf)) {
      throw "uninstall.ps1 not found next to the payload ($UninstallSrc)"
    }

    # ---- preflight: settings.json must be a valid JSON object before anything is written ----
    $settingsPath = Join-Path $T 'settings.json'
    $settings = $null
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
      $bad = $false
      try { $settings = (Read-Text $settingsPath).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { $bad = $true }
      if ($bad -or ($settings -isnot [System.Management.Automation.PSCustomObject])) {
        throw "$settingsPath is not a valid JSON object; nothing was changed. Fix it and rerun."
      }
    }

    # ---- new manifest ----
    New-Item -ItemType Directory -Path (Join-Path $T 'cds-skills') -Force | Out-Null
    $new = New-Object Collections.Generic.List[string]
    $sets = @(
      @{ Dir = 'skills'; Dirs = $true; Filter = '*' },
      @{ Dir = 'agents'; Dirs = $false; Filter = '*.md' },
      @{ Dir = 'rules'; Dirs = $false; Filter = '*.md' }
    )
    foreach ($s in $sets) {
      $src = Join-Path $P $s.Dir
      if (-not (Test-Path -LiteralPath $src -PathType Container)) { continue }
      if ($s.Dirs) { $items = Get-ChildItem -LiteralPath $src -Directory } else { $items = Get-ChildItem -LiteralPath $src -File -Filter $s.Filter }
      foreach ($e in ($items | Sort-Object Name)) {
        $name = "$($s.Dir)/$($e.Name)"
        if (-not (Test-Allowed $name)) { throw "payload entry not allowed: $name" }
        $new.Add($name)
      }
    }
    if (Test-Path -LiteralPath (Join-Path $P 'output-styles\cds.md') -PathType Leaf) { $new.Add('output-styles/cds.md') }

    # ---- remove stale entries of the previous manifest ----
    $manifest = Join-Path $T 'cds-skills\manifest.txt'
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
      foreach ($line in ((Read-Text $manifest) -split "`n")) {
        $line = $line.TrimEnd("`r")
        if (($new -cnotcontains $line) -and (Test-Allowed $line)) {
          $victim = Join-Rel $T $line
          if (Test-Path -LiteralPath $victim) { Remove-Item -LiteralPath $victim -Recurse -Force }
        }
      }
    }

    # ---- copy ----
    foreach ($d in 'skills', 'agents', 'rules', 'output-styles') { New-Item -ItemType Directory -Path (Join-Path $T $d) -Force | Out-Null }
    $nSkills = 0; $nAgents = 0; $nRules = 0
    foreach ($line in $new) {
      $from = Join-Rel $P $line
      if ($line.StartsWith('skills/')) {
        $to = Join-Rel $T $line
        if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
        Copy-Item -LiteralPath $from -Destination (Join-Path $T 'skills') -Recurse -Force
        $nSkills++
      } elseif ($line.StartsWith('agents/')) {
        Copy-Item -LiteralPath $from -Destination (Join-Path $T 'agents') -Force; $nAgents++
      } elseif ($line.StartsWith('rules/')) {
        Copy-Item -LiteralPath $from -Destination (Join-Path $T 'rules') -Force; $nRules++
      } elseif ($line.StartsWith('output-styles/')) {
        Copy-Item -LiteralPath $from -Destination (Join-Path $T 'output-styles') -Force
      }
    }
    Copy-Item -LiteralPath $UninstallSrc -Destination (Join-Path $T 'cds-skills\uninstall.ps1') -Force
    Write-Text $manifest (($new -join "`n") + "`n")

    # ---- CLAUDE.md block (written in place: symlinks are followed) ----
    $claude = Join-Path $T 'CLAUDE.md'
    $block = $Start + "`n" + (Read-Text (Join-Path $P 'CLAUDE.md')).TrimEnd("`n") + "`n" + $End
    $block = $Latin1.GetString($Utf8.GetBytes($block))
    $content = ''
    if (Test-Path -LiteralPath $claude -PathType Leaf) {
      $ts = Get-Date -Format 'yyyyMMddHHmmss'
      $bk = Join-Path $T "CLAUDE.md.cds-backup-$ts"
      $i = 1
      while (Test-Path -LiteralPath $bk) { $bk = Join-Path $T "CLAUDE.md.cds-backup-$ts-$i"; $i++ }
      $bytes = [IO.File]::ReadAllBytes($claude)
      [IO.File]::WriteAllBytes($bk, $bytes)
      $content = $Latin1.GetString($bytes)
    }
    $si = $content.IndexOf($Start, [StringComparison]::Ordinal)
    $ei = -1
    if ($si -ge 0) { $ei = $content.IndexOf($End, $si + $Start.Length, [StringComparison]::Ordinal) }
    if ($si -ge 0 -and $ei -ge 0) {
      $out = $content.Substring(0, $si) + $block + $content.Substring($ei + $End.Length)
      $claudeMsg = 'block replaced'
    } elseif ($content.Length -gt 0) {
      if (-not $content.EndsWith("`n")) { $content = $content + "`n" }
      $out = $content + "`n" + $block + "`n"
      $claudeMsg = 'block appended'
    } else {
      $out = $block + "`n"
      $claudeMsg = 'file created'
    }
    [IO.File]::WriteAllText($claude, $out, $Latin1)

    # ---- output style ----
    if ($null -eq $settings) { $settings = New-Object PSObject }
    $settings | Add-Member -NotePropertyName 'outputStyle' -NotePropertyValue 'cds' -Force
    Write-Text $settingsPath ((ConvertTo-Json -InputObject $settings -Depth 100) + "`n")

    Write-Host ''
    Write-Host "cds-skills installed into $T"
    Write-Host "  skills: $nSkills, agents: $nAgents, rules: $nRules"
    Write-Host "  CLAUDE.md: $claudeMsg"
    Write-Host '  output style: outputStyle set to cds in settings.json'
    Write-Host "  uninstall: & `"$(Join-Path $T 'cds-skills\uninstall.ps1')`""
  } finally {
    if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
