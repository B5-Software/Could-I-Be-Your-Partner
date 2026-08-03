$exe = "D:\vs_buildtools.exe"
$args = @(
    "modify",
    "--installPath",
    "D:\Program Files\Microsoft Visual Studio\18\Community",
    "--add",
    "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
    "--add",
    "Microsoft.VisualStudio.Component.VC.14.50.18.0.ARM64",
    "--passive",
    "--norestart",
    "--wait"
)
Write-Host "Starting vs_buildtools.exe..."
Write-Host "PLEASE CLICK YES ON THE UAC PROMPT!"
try {
    $proc = Start-Process -FilePath $exe -ArgumentList $args -Verb RunAs -Wait -PassThru -ErrorAction Stop
    Write-Host "Exit code: $($proc.ExitCode)"
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Write-Host "Trying without RunAs..."
    $proc = Start-Process -FilePath $exe -ArgumentList $args -Wait -PassThru
    Write-Host "Exit code: $($proc.ExitCode)"
}
