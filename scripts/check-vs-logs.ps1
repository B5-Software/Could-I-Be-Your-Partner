$logDir = "$env:TEMP"
$logs = Get-ChildItem $logDir -Filter "dd_setup_*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5
if ($logs) {
    Write-Host "Recent setup logs:"
    foreach ($log in $logs) {
        Write-Host "  $($log.Name) - $($log.LastWriteTime) - $($log.Length) bytes"
    }
    Write-Host "`n--- Latest log content (last 50 lines) ---"
    Get-Content $logs[0].FullName -Tail 50
} else {
    Write-Host "No dd_setup logs found in TEMP"
}

# Check vs_installer logs
$vsLogs = Get-ChildItem $logDir -Filter "vs_installer_*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3
if ($vsLogs) {
    Write-Host "`nVS Installer logs:"
    foreach ($log in $vsLogs) {
        Write-Host "  $($log.Name) - $($log.LastWriteTime)"
    }
}

# Check if any VS installer process is running
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'setup|installer' -and $_.Path -match 'Visual Studio' }
if ($procs) {
    Write-Host "`nRunning VS processes:"
    $procs | Select-Object Id, ProcessName | Format-Table -AutoSize
} else {
    Write-Host "`nNo VS installer processes running"
}
