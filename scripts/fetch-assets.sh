#!/usr/bin/env bash
#
# 一键下载所有被 .gitignore 忽略的第三方资源（Font Awesome / Tesseract OCR / GeoGebra / Three.js）
#
# 用法:
#   ./fetch-assets.sh                              # 直连下载全部
#   ./fetch-assets.sh --mirror https://mirror.ghproxy.com   # 使用 GitHub 镜像
#   ./fetch-assets.sh --skip-ocr --tessdata-variant fast     # 跳过OCR，或选 fast/best 版本
#   ./fetch-assets.sh --skip-three                          # 跳过 Three.js
#
set -euo pipefail

MIRROR=""
SKIP_OCR=false
SKIP_FA=false
SKIP_GGB=false
SKIP_THREE=false
TESSDATA_VARIANT="standard"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mirror)           MIRROR="$2"; shift 2 ;;
    --skip-ocr)         SKIP_OCR=true; shift ;;
    --skip-fontawesome) SKIP_FA=true; shift ;;
    --skip-geogebra)    SKIP_GGB=true; shift ;;
    --skip-three)       SKIP_THREE=true; shift ;;
    --tessdata-variant) TESSDATA_VARIANT="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--mirror URL] [--skip-ocr] [--skip-fontawesome] [--skip-geogebra] [--skip-three] [--tessdata-variant standard|fast|best]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

info()  { echo -e "\n\033[36m[*] $1\033[0m"; }
ok()    { echo -e "    \033[32m[OK] $1\033[0m"; }
warn()  { echo -e "    \033[33m[!]  $1\033[0m"; }
err()   { echo -e "    \033[31m[X]  $1\033[0m"; }

build_url() {
  local url="$1"
  if [[ -n "$MIRROR" ]]; then echo "${MIRROR}/${url}"; else echo "$url"; fi
}

download() {
  local url="$1"
  local dest="$2"
  local final_url
  final_url="$(build_url "$url")"
  echo "    Downloading: $final_url"
  local code=0
  curl -L --fail --connect-timeout 30 --max-time 600 -o "$dest" "$final_url" || code=$?
  if [[ $code -ne 0 ]]; then
    if [[ -n "$MIRROR" ]]; then
      warn "Mirror failed, retrying direct..."
      curl -L --fail --connect-timeout 30 --max-time 600 -o "$dest" "$url" || code=$?
    fi
  fi
  if [[ $code -ne 0 ]]; then
    err "Failed to download: $url"
    return 1
  fi
  local size
  size=$(du -h "$dest" 2>/dev/null | cut -f1 || echo "?")
  ok "$dest ($size)"
  return 0
}

echo -e "\033[36m========================================"
echo "  CIBYP Assets Downloader"
echo "========================================\033[0m"
echo "Repo root: $REPO_ROOT"
if [[ -n "$MIRROR" ]]; then echo -e "\033[33mUsing mirror: $MIRROR\033[0m"; else echo "Direct connection (no mirror)"; fi
[[ "$TESSDATA_VARIANT" != "standard" ]] && echo "Tessdata variant: $TESSDATA_VARIANT"

# ---- Font Awesome 6.5.1 ----
if [[ "$SKIP_FA" == "false" ]]; then
  info "Font Awesome 6.5.1"
  fonts_dir="$REPO_ROOT/assets/fonts"
  webfonts_dir="$REPO_ROOT/assets/webfonts"
  mkdir -p "$fonts_dir" "$webfonts_dir"

  if [[ -f "$fonts_dir/fontawesome.min.css" ]]; then
    ok "Font Awesome already exists, skipping"
  else
    zip_url="https://github.com/FortAwesome/Font-Awesome/releases/download/6.5.1/fontawesome-free-6.5.1-web.zip"
    zip_path="/tmp/fontawesome-6.5.1-$$.zip"
    extract_path="/tmp/fontawesome-6.5.1-$$"

    if download "$zip_url" "$zip_path"; then
      mkdir -p "$extract_path"
      if command -v unzip &>/dev/null; then
        unzip -q -o "$zip_path" -d "$extract_path"
      else
        echo "    Extracting with Python (unzip not found)..."
        python3 -c "import zipfile; zipfile.ZipFile('$zip_path').extractall('$extract_path')"
      fi
      src_dir="$extract_path/fontawesome-free-6.5.1-web"

      cp -f "$src_dir/css/"* "$fonts_dir/"
      ok "CSS files -> assets/fonts/"

      cp -f "$src_dir/webfonts/"* "$webfonts_dir/"
      ok "Webfont files -> assets/webfonts/"

      rm -f "$zip_path"; rm -rf "$extract_path"
    else
      warn "Font Awesome download failed, you may need to download manually"
    fi
  fi
fi

# ---- Tesseract OCR ----
if [[ "$SKIP_OCR" == "false" ]]; then
  info "Tesseract OCR Training Data ($TESSDATA_VARIANT)"
  ocr_dir="$REPO_ROOT/assets/ocr"
  mkdir -p "$ocr_dir"

  case "$TESSDATA_VARIANT" in
    standard) tess_repo="tessdata" ;;
    fast)     tess_repo="tessdata_fast" ;;
    best)     tess_repo="tessdata_best" ;;
  esac

  for lang in chi_sim eng; do
    dest_file="$ocr_dir/$lang.traineddata"
    if [[ -f "$dest_file" ]]; then
      existing_size=$(stat -c%s "$dest_file" 2>/dev/null || stat -f%z "$dest_file" 2>/dev/null || echo 0)
      if [[ $existing_size -gt 1048576 ]]; then
        ok "$lang.traineddata already exists, skipping"
        continue
      fi
    fi
    url="https://github.com/tesseract-ocr/$tess_repo/raw/main/$lang.traineddata"
    download "$url" "$dest_file" || true
  done

  # 根目录保留同款训练数据副本（历史约定：根目录 + assets/ocr 两处，均被 .gitignore 忽略）
  for lang in chi_sim eng; do
    src_file="$ocr_dir/$lang.traineddata"
    root_copy="$REPO_ROOT/$lang.traineddata"
    if [[ -f "$src_file" ]]; then
      src_size=$(stat -c%s "$src_file" 2>/dev/null || stat -f%z "$src_file" 2>/dev/null || echo 0)
      need_copy=true
      if [[ -f "$root_copy" ]]; then
        root_size=$(stat -c%s "$root_copy" 2>/dev/null || stat -f%z "$root_copy" 2>/dev/null || echo 0)
        [[ "$root_size" == "$src_size" ]] && need_copy=false
      fi
      if [[ "$need_copy" == "true" ]]; then
        cp -f "$src_file" "$root_copy" && ok "Copied $lang.traineddata to repo root"
      fi
    fi
  done
fi

# ---- GeoGebra deployggb.js ----
if [[ "$SKIP_GGB" == "false" ]]; then
  info "GeoGebra deployggb.js"
  ggb_dir="$REPO_ROOT/assets/geogebra"
  mkdir -p "$ggb_dir"
  ggb_file="$ggb_dir/deployggb.js"

  if [[ -f "$ggb_file" ]]; then
    ok "deployggb.js already exists, skipping"
  else
    # GeoGebra 不在 GitHub，直连即可
    url="https://www.geogebra.org/apps/deployggb.js"
    download "$url" "$ggb_file" || true
  fi

  # ---- GeoGebra Math Apps Bundle 离线包（完整 web3d/webSimple/web 编译产物）----
  info "GeoGebra Math Apps Bundle（离线包，运行时经 ggb:// 本地加载）"
  ggb_app_dir="$REPO_ROOT/assets/geogebra-app"
  ggb_nocache="$ggb_app_dir/GeoGebra/HTML5/5.0/web3d/web3d.nocache.js"
  if [[ -f "$ggb_nocache" && -f "$ggb_app_dir/GeoGebra/deployggb.js" ]]; then
    ok "geogebra-app already extracted, skipping"
  else
    bundle_url="https://download.geogebra.org/package/geogebra-math-apps-bundle"
    zip_path="/tmp/geogebra-math-apps-bundle-$$.zip"
    if download "$bundle_url" "$zip_path"; then
      mkdir -p "$ggb_app_dir"
      if command -v unzip &>/dev/null; then
        unzip -q -o "$zip_path" -d "$ggb_app_dir"
      elif command -v tar &>/dev/null; then
        tar -xf "$zip_path" -C "$ggb_app_dir"
      else
        python3 -c "import zipfile; zipfile.ZipFile('$zip_path').extractall('$ggb_app_dir')"
      fi
      # 同步包内 deployggb.js 到 assets/geogebra/（排列哈希与 927 产物一致）
      cp -f "$ggb_app_dir/GeoGebra/deployggb.js" "$ggb_file"
      rm -f "$zip_path"
      ok "geogebra-app extracted"
    else
      warn "GeoGebra Math Apps Bundle download failed, GeoGebra 运行时将退化为不可用"
    fi
  fi

  # ---- GeoGebra 完整源码（参考用，不打包）----
  info "GeoGebra 源码 (geogebra/geogebra)"
  ggb_src_dir="$REPO_ROOT/assets/geogebra-src"
  if [[ -d "$ggb_src_dir/.git" ]]; then
    ok "geogebra-src already cloned, skipping"
  else
    clone_url="https://github.com/geogebra/geogebra.git"
    if [[ -n "$MIRROR" ]]; then
      mirrored_url="$MIRROR/$clone_url"
      echo "    Try mirror: $mirrored_url"
      git clone --depth 1 "$mirrored_url" "$ggb_src_dir" 2>/dev/null
      if [[ $? -ne 0 ]]; then
        warn "Mirror clone failed, retrying direct..."
        rm -rf "$ggb_src_dir"
        git clone --depth 1 "$clone_url" "$ggb_src_dir" 2>/dev/null
      fi
    else
      git clone --depth 1 "$clone_url" "$ggb_src_dir" 2>/dev/null
    fi
    if [[ -d "$ggb_src_dir/.git" ]]; then
      size=$(du -sm "$ggb_src_dir" 2>/dev/null | cut -f1)
      ok "geogebra-src cloned (${size} MB)"
    else
      err "Failed to clone geogebra/geogebra (network issue?), source code is optional, continuing..."
    fi
  fi
  # 说明：geogebra/geogebra 是 Gradle 源码工程，仅作参考，不参与运行。
  # 运行时加载的是上方 Math Apps Bundle 的本地编译产物（完整离线，不依赖 www.geogebra.org CDN）。
fi

# ---- Three.js 0.160.0 (PCB-EDA 3D 预览用) ----
if [[ "$SKIP_THREE" == "false" ]]; then
  info "Three.js 0.160.0"
  three_dir="$REPO_ROOT/assets/lib/three"
  mkdir -p "$three_dir"
  three_file="$three_dir/three.min.js"

  need_download=false
  if [[ ! -f "$three_file" ]]; then
    need_download=true
  else
    existing_size=$(stat -c%s "$three_file" 2>/dev/null || stat -f%z "$three_file" 2>/dev/null || echo 0)
    if [[ $existing_size -lt 102400 ]]; then need_download=true; fi
  fi
  if [[ "$need_download" == "true" ]]; then
    rm -f "$three_file"
    # Three.js 不在 GitHub raw（仓库的 build/three.min.js 是构建产物）
    # 走 jsDelivr CDN（npm 镜像，全球加速）
    url="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"
    if ! download "$url" "$three_file"; then
      warn "jsDelivr failed, trying unpkg..."
      url2="https://unpkg.com/three@0.160.0/build/three.min.js"
      download "$url2" "$three_file" || true
    fi
  else
    ok "three.min.js already exists, skipping"
  fi
  # 注：Three.js 0.160.0 已移除 UMD 版的 OrbitControls（仅保留 ESM 模块版本）
  # 因此 pcb-3d.js 内部自带了一个轻量 OrbitControls 实现（旋转/缩放/平移），无需下载额外文件。
fi

# ---- IME 词库（雾凇拼音 GPL-3.0 + Leipzig CC BY 4.0） ----
info "IME 词库（中文拼音 / 英文 / 德文预测）"
ime_dir="$REPO_ROOT/assets/ime"
ime_zh="$ime_dir/ime-dict-zh.js"
if [[ ! -f "$ime_zh" ]]; then
  if ! (cd "$REPO_ROOT" && node scripts/build-ime-dicts.js); then
    warn "IME 词库生成失败（可稍后手动运行 node scripts/build-ime-dicts.js）"
  fi
else
  ok "IME 词库已存在，跳过（如需更新请删除 $ime_zh 后重跑）"
fi

echo -e "\n\033[36m========================================"
echo -e "  \033[32mDone!\033[0m"
echo -e "\033[36m========================================\033[0m"
