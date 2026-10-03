# SPDX-License-Identifier: GPL-3.0-or-later
function Update-CibypPathValue {
    param([AllowEmptyString()][string]$PathValue, [string]$Directory, [bool]$Remove)
    $target = $Directory.TrimEnd('\').ToLowerInvariant()
    $parts = @($PathValue -split ';' | Where-Object {
        [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\').ToLowerInvariant() -ne $target
    })
    if ($Remove) { return $parts -join ';' }
    if ([string]::IsNullOrEmpty($PathValue)) { return $Directory }
    return (@($parts) + $Directory) -join ';'
}

function Set-CibypCommandPath {
    param([string]$Directory, [ValidateSet('User','Machine')][string]$Scope, [bool]$Remove)
    if ($Scope -eq 'Machine') {
        $hive = [Microsoft.Win32.Registry]::LocalMachine
        $subkey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
    } else {
        $hive = [Microsoft.Win32.Registry]::CurrentUser
        $subkey = 'Environment'
    }
    $key = $hive.CreateSubKey($subkey)
    try {
        $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
        $updated = Update-CibypPathValue $value $Directory $Remove
        if ($updated -ne $value) { $key.SetValue('Path', $updated, $kind) }
    } finally { $key.Dispose() }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CibypEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr result); }'
    $result = [UIntPtr]::Zero
    [void][CibypEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result)
}
