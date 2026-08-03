$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
Write-Host "All VS instances:"
$result = & $vswhere -all -prerelease -format json
$instances = $result | ConvertFrom-Json
foreach ($inst in $instances) {
    Write-Host "  Path: $($inst.installationPath)"
    Write-Host "  Version: $($inst.installationVersion)"
    Write-Host "  Product: $($inst.productId)"
    Write-Host "  Channel: $($inst.channelId)"
    Write-Host ""
}
