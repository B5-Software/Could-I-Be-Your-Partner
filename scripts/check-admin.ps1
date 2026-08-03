$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "User: $($identity.Name)"
Write-Host "Is Admin: $isAdmin"
Write-Host "ElevationType: $([System.Diagnostics.Process]::GetCurrentProcess().StartInfo.Verb)"
