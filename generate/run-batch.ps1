# Runs generate/music.py over a prompt batch and restarts it whenever no new track has appeared for
# $StallMinutes. The prompt that hung keeps its ".started" mark, so music.py skips it on the restart.
# Two stalls in a row mean the GPU itself is slow (another app on it, e.g. an animated wallpaper): then it
# clears both marks, so those prompts aren't lost, and stops.
#   powershell -File generate\run-batch.ps1 -Prompts generate\batch-1.json [-Out C:\Users\Cypress\ambient-pool\music]
param(
  [Parameter(Mandatory)][string]$Prompts,
  [string]$Out = 'C:\Users\Cypress\ambient-pool\music',
  [string]$AceRoot = 'C:\Users\Cypress\tools\ace-step\ACE-Step-1.5',
  [int]$StallMinutes = 8
)
$env:HF_HOME = Join-Path (Split-Path $AceRoot) 'hf'; $env:HF_HUB_OFFLINE = '1'; $env:PYTHONIOENCODING = 'utf-8'
$script = Join-Path $PSScriptRoot 'music.py'
$total = (Get-Content $Prompts -Raw | ConvertFrom-Json).Count
$count = { (Get-ChildItem $Out -Recurse -Filter *.flac | Where-Object { $_.DirectoryName -like '*ai-acestep' }).Count }
$marks = { Get-ChildItem (Join-Path $Out '.acestep') -Filter *.started -ErrorAction SilentlyContinue }
$stalledMarks = @()
for ($run = 1; $run -le 25; $run++) {
  $log = Join-Path (Split-Path $AceRoot) "batch-run$run.log"
  $p = Start-Process -FilePath (Join-Path $AceRoot '.venv\Scripts\python.exe') -ArgumentList "`"$script`"", "`"$Out`"", "`"$Prompts`"" `
    -WorkingDirectory $AceRoot -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $last = & $count; $since = Get-Date; $stalled = $false
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 30
    $now = & $count
    if ($now -ne $last) { $last = $now; $since = Get-Date; $stalledMarks = @() }
    elseif (((Get-Date) - $since).TotalMinutes -ge $StallMinutes) {
      "run $run stalled at $now tracks" | Tee-Object -Append (Join-Path (Split-Path $AceRoot) 'batch-watchdog.log')
      taskkill /PID $p.Id /T /F | Out-Null; Start-Sleep -Seconds 5  # /T: the venv python.exe is a launcher with a child
      $stalled = $true; break
    }
  }
  if ($stalled) {
    $stalledMarks += @(& $marks | Where-Object { $_.LastWriteTime -ge $since.AddMinutes(-$StallMinutes) })
    if ($stalledMarks.Count -ge 2) {
      $stalledMarks | ForEach-Object { [IO.File]::Delete($_.FullName) }
      "two stalls in a row: is another app using the GPU? Stopped; the stalled prompts will run next time." | Tee-Object -Append (Join-Path (Split-Path $AceRoot) 'batch-watchdog.log')
      exit 1
    }
    continue
  }
  if ($p.HasExited -and $p.ExitCode -eq 0) { "batch finished: $(& $count) tracks on disk (of $total prompts plus earlier ones)"; break }
}
