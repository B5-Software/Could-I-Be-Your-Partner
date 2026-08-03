$target = 'D:\Electron-Projects\Could-I-Be-Your-Partner\dist'
$asar = Join-Path $target 'win-unpacked\resources\app.asar'

$removed = $false
for ($i = 1; $i -le 10; $i++) {
    if (-not (Test-Path $target)) {
        $removed = $true
        break
    }
    if (Test-Path $asar) {
        try {
            [System.IO.File]::Delete($asar)
            Write-Host "[$i] asar deleted"
        } catch {
            Write-Host "[$i] asar still locked, waiting 5s..."
        }
    }
    cmd /c "rd /S /Q `"$target`" 2>nul"
    if (-not (Test-Path $target)) {
        Write-Host "[$i] dist removed"
        $removed = $true
        break
    }
    Start-Sleep -Seconds 5
}

if (-not $removed) {
    if (Test-Path $target) {
        $newName = "$target.old-$([DateTime]::Now.Ticks)"
        try {
            Rename-Item -LiteralPath $target -NewName $newName -ErrorAction Stop
            Write-Host "renamed to $newName"
            Start-Sleep -Seconds 2
            cmd /c "rd /S /Q `"$newName`" 2>nul"
        } catch {
            Write-Host "rename FAIL: $($_.Exception.Message)"
        }
    }
}

if (-not (Test-Path $target)) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Write-Host "DONE clean"
} else {
    Write-Host "STILL EXISTS"
}
