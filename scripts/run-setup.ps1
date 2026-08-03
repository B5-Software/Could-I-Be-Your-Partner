$exe = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe"
$installPath = "D:\Program Files\Microsoft Visual Studio\18\Community"
$argString = "modify --installPath `"$installPath`" --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 --add Microsoft.VisualStudio.Component.VC.14.50.18.0.ARM64 --passive --norestart --wait"
Write-Host "Starting setup.exe..."
Write-Host "PLEASE CLICK YES ON THE UAC PROMPT!"
try {
    $proc = Start-Process -FilePath $exe -ArgumentList $argString -Verb RunAs -Wait -PassThru -ErrorAction Stop
    Write-Host "Exit code: $($proc.ExitCode)"
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}
