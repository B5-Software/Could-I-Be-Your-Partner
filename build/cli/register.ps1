# SPDX-License-Identifier: GPL-3.0-or-later
param([Parameter(Mandatory)][ValidateSet('Install','Remove')][string]$Action,
      [Parameter(Mandatory)][string]$Directory,
      [ValidateSet('User','Machine')][string]$Scope = 'User')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\path-management.ps1"
Set-CibypCommandPath -Directory $Directory -Scope $Scope -Remove ($Action -eq 'Remove')
