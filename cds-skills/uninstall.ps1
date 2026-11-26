# cds-skills uninstaller (Windows PowerShell 5.1 and PowerShell 7): removes only what the manifest lists
# (allowlisted), the CLAUDE.md block and outputStyle when it equals "cds". Safe to run twice.
# Env: CLAUDE_CONFIG_DIR (default $HOME\.claude).
& {
  $ErrorActionPreference = 'Stop'
  $Start = '<!-- cds:start -->'
  $End = '<!-- cds:end -->'
  $Utf8 = New-Object Text.UTF8Encoding $false

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

  $removed = 0
  $manifest = Join-Path $T 'cds-skills\manifest.txt'
  if (Test-Path -LiteralPath $manifest -PathType Leaf) {
    foreach ($line in ((Read-Text $manifest) -split "`n")) {
      $line = $line.TrimEnd("`r")
      if (Test-Allowed $line) {
        $victim = Join-Rel $T $line
        if (Test-Path -LiteralPath $victim) { Remove-Item -LiteralPath $victim -Recurse -Force; $removed++ }
      }
    }
  }

  # CLAUDE.md block
  $blockMsg = 'no block found'
  $claude = Join-Path $T 'CLAUDE.md'
  if (Test-Path -LiteralPath $claude -PathType Leaf) {
    $bytes = [IO.File]::ReadAllBytes($claude)
    $content = $Latin1.GetString($bytes)
    $si = $content.IndexOf($Start, [StringComparison]::Ordinal)
    $ei = -1
    if ($si -ge 0) { $ei = $content.IndexOf($End, $si + $Start.Length, [StringComparison]::Ordinal) }
    if ($si -ge 0 -and $ei -ge 0) {
      $ts = Get-Date -Format 'yyyyMMddHHmmss'
      $bk = Join-Path $T "CLAUDE.md.cds-backup-$ts"
      $i = 1
      while (Test-Path -LiteralPath $bk) { $bk = Join-Path $T "CLAUDE.md.cds-backup-$ts-$i"; $i++ }
      [IO.File]::WriteAllBytes($bk, $bytes)
      $before = $content.Substring(0, $si)
      $after = $content.Substring($ei + $End.Length)
      # drop the separator blank line the installer added when the block was appended
      if ($before.EndsWith("`n`n") -and ($after.Length -eq 0 -or $after -ceq "`n")) {
        $before = $before.Substring(0, $before.Length - 1)
        $after = ''
      }
      [IO.File]::WriteAllText($claude, ($before + $after), $Latin1)
      $blockMsg = "block removed (backup: $bk)"
    }
  }

  # output style
  $styleMsg = 'outputStyle untouched'
  $settingsPath = Join-Path $T 'settings.json'
  if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $settings = $null
    try { $settings = (Read-Text $settingsPath).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { $settings = $null }
    if (($settings -is [System.Management.Automation.PSCustomObject]) -and ($settings.PSObject.Properties['outputStyle']) -and ($settings.outputStyle -ceq 'cds')) {
      [void]$settings.PSObject.Properties.Remove('outputStyle')
      Write-Text $settingsPath ((ConvertTo-Json -InputObject $settings -Depth 100) + "`n")
      $styleMsg = 'outputStyle removed'
    }
  }

  $own = Join-Path $T 'cds-skills'
  if (Test-Path -LiteralPath $own) { Remove-Item -LiteralPath $own -Recurse -Force }
  Write-Host "cds-skills uninstalled from $T"
  Write-Host "  files removed: $removed"
  Write-Host "  CLAUDE.md: $blockMsg"
  Write-Host "  output style: $styleMsg"
}
