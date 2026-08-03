$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    Write-Host "VS instances:"
    $result = & $vswhere -all -format json
    $instances = $result | ConvertFrom-Json
    foreach ($inst in $instances) {
        Write-Host "  Path: $($inst.installationPath)"
        Write-Host "  Version: $($inst.installationVersion)"
        Write-Host "  Channel: $($inst.channelId)"
        Write-Host "  Product: $($inst.productId)"
        Write-Host ""
    }
} else {
    Write-Host "vswhere not found"
}
