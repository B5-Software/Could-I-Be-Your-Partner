$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'installer|setup' }
if ($procs) {
    $procs | Select-Object Id, ProcessName, StartTime, Path | Format-Table -AutoSize
} else {
    Write-Host "No installer processes running"
}

# Check latest log
$logDir = "$env:TEMP"
$logs = Get-ChildItem $logDir -Filter "dd_setup_*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($logs) {
    Write-Host "`nLatest log: $($logs[0].Name) - $($logs[0].LastWriteTime)"
    Write-Host "--- Last 20 lines ---"
    Get-Content $logs[0].FullName -Tail 20
}

# Check ARM64 platform
$arm64Path = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Microsoft\VC\v180\Platforms\arm64'
if (Test-Path $arm64Path) {
    Write-Host "`nARM64 platform EXISTS!"
} else {
    Write-Host "`nARM64 platform not yet available"
}
