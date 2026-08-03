$exe = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe"
$installPath = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools"
$args = @(
    "modify",
    "--installPath",
    "`"$installPath`"",
    "--add",
    "Microsoft.VisualStudio.Component.VC.14.50.18.0.ARM64.Spectre",
    "--passive",
    "--norestart"
)
Write-Host "Installing ARM64 Spectre libs to C drive BuildTools..."
Write-Host "PLEASE CLICK YES ON THE UAC PROMPT!"
try {
    $proc = Start-Process -FilePath $exe -ArgumentList $args -Verb RunAs -Wait -PassThru -ErrorAction Stop
    Write-Host "Exit code: $($proc.ExitCode)"
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}
