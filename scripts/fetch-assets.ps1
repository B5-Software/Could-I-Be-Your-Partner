<#
.SYNOPSIS
  一键下载所有被 .gitignore 忽略的第三方资源（Font Awesome / Tesseract OCR / GeoGebra / Three.js）
.DESCRIPTION
  脚本会下载以下资源到对应目录：
    - Font Awesome 6.5.1 CSS  -> assets/fonts/
    - Font Awesome 字体      -> assets/webfonts/
    - Tesseract OCR 训练数据  -> assets/ocr/  (chi_sim + eng)
    - GeoGebra deployggb.js  -> assets/geogebra/
    - Three.js 0.160.0       -> assets/lib/three/  (PCB-EDA 3D 预览用)
  支持通过 -Mirror 参数指定 GitHub 镜像前缀（应对 GFW），默认直连。
.PARAMETER Mirror
  GitHub 下载镜像前缀，如 "https://mirror.ghproxy.com"（会拼到原始 GitHub URL 前）
.PARAMETER SkipOCR
  跳过 OCR 训练数据下载（文件较大）
.PARAMETER SkipFontAwesome
  跳过 Font Awesome 下载
.PARAMETER SkipGeoGebra
  跳过 GeoGebra deployggb.js 下载
.PARAMETER SkipThree
  跳过 Three.js 下载
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
  [switch]$SkipThree,
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

  # ---- GeoGebra Math Apps Bundle 离线包（完整 web3d/webSimple/web 编译产物）----
  Write-Step "GeoGebra Math Apps Bundle（离线包，运行时经 ggb:// 本地加载）"
  $ggbAppDir = Join-Path $repoRoot "assets\geogebra-app"
  $ggbNocache = Join-Path $ggbAppDir "GeoGebra\HTML5\5.0\web3d\web3d.nocache.js"
  $ggbBundleDeploy = Join-Path $ggbAppDir "GeoGebra\deployggb.js"
  if ((Test-Path $ggbNocache) -and (Test-Path $ggbBundleDeploy)) {
    Write-Ok "geogebra-app already extracted, skipping"
  } else {
    $bundleUrl = "https://download.geogebra.org/package/geogebra-math-apps-bundle"
    $zipPath = Join-Path $env:TEMP "geogebra-math-apps-bundle-$([guid]::NewGuid().ToString('N')).zip"
    if (Download-File $bundleUrl $zipPath) {
      New-Item -ItemType Directory -Force -Path $ggbAppDir | Out-Null
      try {
        Expand-Archive -Path $zipPath -DestinationPath $ggbAppDir -Force
        # 同步包内 deployggb.js 到 assets/geogebra/（排列哈希与 927 产物一致）
        Copy-Item -Force $ggbBundleDeploy $ggbFile
        Write-Ok "geogebra-app extracted"
      } catch {
        Write-Err "Expand-Archive failed: $($_.Exception.Message)"
      } finally {
        Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
      }
    } else {
      Write-Warn "GeoGebra Math Apps Bundle download failed, GeoGebra 运行时将退化为不可用"
    }
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
  # 运行时加载的是上方 Math Apps Bundle 的本地编译产物（完整离线，不依赖 www.geogebra.org CDN）。
}

# ---- Three.js 0.160.0 (PCB-EDA 3D 预览用) ----
if (-not $SkipThree) {
  Write-Step "Three.js 0.160.0"
  $threeDir = Join-Path $repoRoot "assets\lib\three"
  New-Item -ItemType Directory -Force -Path $threeDir | Out-Null
  $threeFile = Join-Path $threeDir "three.min.js"

  if (Test-Path $threeFile) {
    $existingSize = (Get-Item $threeFile).Length
    if ($existingSize -gt 100KB) {
      Write-Ok "three.min.js already exists ($([math]::Round($existingSize/1KB,1)) KB), skipping"
    } else {
      Remove-Item $threeFile -Force
    }
  }
  if (-not (Test-Path $threeFile)) {
    # Three.js 不在 GitHub raw（mrdoob/three.js 仓库的 build/three.min.js 是构建产物）
    # 走 jsDelivr CDN（npm 镜像，全球加速）
    $url = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"
    $ok = Download-File $url $threeFile
    if (-not $ok -or -not (Test-Path $threeFile)) {
      Write-Warn "jsDelivr failed, trying unpkg..."
      $url2 = "https://unpkg.com/three@0.160.0/build/three.min.js"
      Download-File $url2 $threeFile | Out-Null
    }
  }
  # 注：Three.js 0.160.0 已移除 UMD 版的 OrbitControls（仅保留 ESM 模块版本）
  # 因此 pcb-3d.js 内部自带了一个轻量 OrbitControls 实现（旋转/缩放/平移），无需下载额外文件。
}

Write-Host "`n========================================" -ForegroundColor Cyan

# ---- IME 词库（雾凇拼音 GPL-3.0 + Leipzig CC BY 4.0） ----
Write-Step "IME 词库（中文拼音 / 英文 / 德文预测）"
$imeDir = Join-Path $repoRoot "assets\ime"
$imeZh = Join-Path $imeDir "ime-dict-zh.js"
if (-not (Test-Path $imeZh)) {
  try {
    Push-Location $repoRoot
    node scripts\build-ime-dicts.js
    if ($LASTEXITCODE -ne 0) { throw "build-ime-dicts.js exit $LASTEXITCODE" }
    Pop-Location
  } catch {
    Pop-Location
    Write-Warn "IME 词库生成失败（可稍后手动运行 node scripts/build-ime-dicts.js）：$($_.Exception.Message)"
  }
} else {
  Write-Ok "IME 词库已存在，跳过（如需更新请删除 $imeZh 后重跑）"
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Done!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
