$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'setup|installer|vs_' }
if ($procs) {
    Write-Host "Running processes:"
    $procs | Select-Object Id, ProcessName, StartTime, Path | Format-Table -AutoSize
} else {
    Write-Host "No installer processes running"
}

# Check latest log
$logDir = "$env:TEMP"
$logs = Get-ChildItem $logDir -Filter "dd_setup_*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($logs) {
    Write-Host "`nLatest log: $($logs[0].Name) - Last modified: $($logs[0].LastWriteTime)"
    Write-Host "--- Last 30 lines ---"
    Get-Content $logs[0].FullName -Tail 30
}

# Check for any vs_installer logs
$vsLogs = Get-ChildItem $logDir -Filter "*.log" -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-15) } | Sort-Object LastWriteTime -Descending
if ($vsLogs) {
    Write-Host "`nRecent log files (last 15 min):"
    foreach ($l in $vsLogs) {
        Write-Host "  $($l.Name) - $($l.LastWriteTime) - $($l.Length) bytes"
    }
}
