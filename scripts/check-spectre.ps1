$msvcPath = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC"
Get-ChildItem $msvcPath -Directory | ForEach-Object {
    $libPath = Join-Path $_.FullName "lib\arm64"
    $spectrePath = Join-Path $_.FullName "lib\arm64\spectre"
    $hasLib = Test-Path $libPath
    $hasSpectre = Test-Path $spectrePath
    Write-Host "$($_.Name): lib=$hasLib spectre=$hasSpectre"
}
