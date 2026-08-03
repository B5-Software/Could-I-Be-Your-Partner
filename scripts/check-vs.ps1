Get-Process | Where-Object { $_.ProcessName -match 'setup|vs_installer|vs_installershell' } | Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize
