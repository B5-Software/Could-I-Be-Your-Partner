<#
.SYNOPSIS
  一键下载所有被 .gitignore 忽略的第三方资源（Font Awesome / Tesseract OCR / GeoGebra）
.DESCRIPTION
  脚本会下载以下资源到对应目录：
    - Font Awesome 6.5.1 CSS  -> assets/fonts/
    - Font Awesome 字体      -> assets/webfonts/
    - Tesseract OCR 训练数据  -> assets/ocr/  (chi_sim + eng)
    - GeoGebra deployggb.js  -> assets/geogebra/
  支持通过 -Mirror 参数指定 GitHub 镜像前缀（应对 GFW），默认直连。
.PARAMETER Mirror
  GitHub 下载镜像前缀，如 "https://mirror.ghproxy.com"（会拼到原始 GitHub URL 前）
.PARAMETER SkipOCR
  跳过 OCR 训练数据下载（文件较大）
.PARAMETER SkipFontAwesome
  跳过 Font Awesome 下载
.PARAMETER SkipGeoGebra
  跳过 GeoGebra deployggb.js 下载
.PARAMETER TessdataVariant
  OCR 数据版本：standard(默认) / fast / best
.EXAMPLE
  .\fetch-assets.ps1
  .\fetch-assets.ps1 -Mirror "https://mirror.ghproxy.com"
  .\fetch-assets.ps1 -SkipOCR -TessdataVariant fast
#>
param(
  [string]$Mirror = "",
  [switch]$SkipOCR,
  [switch]$SkipFontAwesome,
  [switch]$SkipGeoGebra,
  [ValidateSet("standard","fast","best")][string]$TessdataVariant = "standard"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [X]  $msg" -ForegroundColor Red }

function Get-Url($url) {
  if ($Mirror) { return "$Mirror/$url" } else { return $url }
}

function Download-File($url, $dest) {
  $finalUrl = Get-Url $url
  Write-Host "    Downloading: $finalUrl"
  try {
    Invoke-WebRequest -Uri $finalUrl -OutFile $dest -UseBasicParsing -TimeoutSec 120
    $size = [math]::Round((Get-Item $dest).Length / 1MB, 1)
    Write-Ok "$dest ($size MB)"
  } catch {
    Write-Err "Failed: $($_.Exception.Message)"
    if ($Mirror) {
      Write-Warn "Retrying without mirror..."
      try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 120
        $size = [math]::Round((Get-Item $dest).Length / 1MB, 1)
        Write-Ok "$dest ($size MB)"
      } catch {
        Write-Err "Direct download also failed: $($_.Exception.Message)"
        return $false
      }
    }
  }
  return $true
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CIBYP Assets Downloader" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Repo root: $repoRoot"
if ($Mirror) { Write-Host "Using mirror: $Mirror" -ForegroundColor Yellow } else { Write-Host "Direct connection (no mirror)" }
if ($TessdataVariant -ne "standard") { Write-Host "Tessdata variant: $TessdataVariant" }

# ---- Font Awesome 6.5.1 ----
if (-not $SkipFontAwesome) {
  Write-Step "Font Awesome 6.5.1"
  $fontsDir = Join-Path $repoRoot "assets\fonts"
  $webfontsDir = Join-Path $repoRoot "assets\webfonts"
  New-Item -ItemType Directory -Force -Path $fontsDir | Out-Null
  New-Item -ItemType Directory -Force -Path $webfontsDir | Out-Null

  # 检查是否已存在
  $faCheck = Join-Path $fontsDir "fontawesome.min.css"
  if (Test-Path $faCheck) {
    Write-Ok "Font Awesome already exists, skipping"
  } else {
    $zipUrl = "https://github.com/FortAwesome/Font-Awesome/releases/download/6.5.1/fontawesome-free-6.5.1-web.zip"
    $zipPath = Join-Path $env:TEMP "fontawesome-6.5.1.zip"
    $extractPath = Join-Path $env:TEMP "fontawesome-6.5.1"

    if (Download-File $zipUrl $zipPath) {
      if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
      Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
      $srcDir = Join-Path $extractPath "fontawesome-free-6.5.1-web"

      # CSS
      Copy-Item (Join-Path $srcDir "css\*") -Destination $fontsDir -Force
      Write-Ok "CSS files -> assets/fonts/"

      # Webfonts
      Copy-Item (Join-Path $srcDir "webfonts\*") -Destination $webfontsDir -Force
      Write-Ok "Webfont files -> assets/webfonts/"

      Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
      Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Write-Warn "Font Awesome download failed, you may need to download manually"
    }
  }
}

# ---- Tesseract OCR ----
if (-not $SkipOCR) {
  Write-Step "Tesseract OCR Training Data ($TessdataVariant)"
  $ocrDir = Join-Path $repoRoot "assets\ocr"
  New-Item -ItemType Directory -Force -Path $ocrDir | Out-Null

  $repoMap = @{ standard = "tessdata"; fast = "tessdata_fast"; best = "tessdata_best" }
  $tessRepo = $repoMap[$TessdataVariant]
  $langs = @("chi_sim", "eng")

  foreach ($lang in $langs) {
    $destFile = Join-Path $ocrDir "$lang.traineddata"
    if (Test-Path $destFile) {
      $existingSize = (Get-Item $destFile).Length
      if ($existingSize -gt 1MB) {
        Write-Ok "$lang.traineddata already exists ($([math]::Round($existingSize/1MB,1)) MB), skipping"
        continue
      }
    }
    $url = "https://github.com/tesseract-ocr/$tessRepo/raw/main/$lang.traineddata"
    Download-File $url $destFile | Out-Null
  }
}

# ---- GeoGebra deployggb.js ----
if (-not $SkipGeoGebra) {
  Write-Step "GeoGebra deployggb.js"
  $ggbDir = Join-Path $repoRoot "assets\geogebra"
  New-Item -ItemType Directory -Force -Path $ggbDir | Out-Null
  $ggbFile = Join-Path $ggbDir "deployggb.js"

  if (Test-Path $ggbFile) {
    Write-Ok "deployggb.js already exists, skipping"
  } else {
    # GeoGebra 不在 GitHub，直连即可
    $url = "https://www.geogebra.org/apps/deployggb.js"
    Download-File $url $ggbFile | Out-Null
  }

  # ---- GeoGebra 完整源码（参考用，不打包）----
  Write-Step "GeoGebra 源码 (geogebra/geogebra)"
  $ggbSrcDir = Join-Path $repoRoot "assets\geogebra-src"
  if (Test-Path (Join-Path $ggbSrcDir ".git")) {
    Write-Ok "geogebra-src already cloned, skipping"
  } else {
    # 优先尝试 GitHub 镜像加速 clone（支持 -Mirror 前缀）
    $cloneUrl = "https://github.com/geogebra/geogebra.git"
    Write-Host "    Cloning: $cloneUrl"
    if ($Mirror) {
      $mirroredUrl = "$Mirror/$cloneUrl"
      Write-Host "    Try mirror: $mirroredUrl"
      git clone --depth 1 $mirroredUrl $ggbSrcDir 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Warn "Mirror clone failed, retrying direct..."
        Remove-Item -Recurse -Force $ggbSrcDir -ErrorAction SilentlyContinue
        git clone --depth 1 $cloneUrl $ggbSrcDir 2>&1 | Out-Null
      }
    } else {
      git clone --depth 1 $cloneUrl $ggbSrcDir 2>&1 | Out-Null
    }
    if (Test-Path (Join-Path $ggbSrcDir ".git")) {
      $size = [math]::Round((Get-ChildItem $ggbSrcDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
      Write-Ok "geogebra-src cloned ($size MB)"
    } else {
      Write-Err "Failed to clone geogebra/geogebra (network issue?), source code is optional, continuing..."
    }
  }
  # 说明：geogebra/geogebra 是 Gradle 源码工程，仅作参考，不参与运行。
  # deployggb.js 运行时仍从 www.geogebra.org CDN 加载 web3d/webSimple 编译产物（源码仓库不含）。
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Done!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
