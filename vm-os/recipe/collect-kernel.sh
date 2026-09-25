#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 B5-Software
#
# 从已部署的镜像中收集内核与 initramfs，供宿主 QEMU 直接引导（-kernel/-initrd）。
# 由 tail.yaml 以 `run` action（chroot: false）调用，可用环境变量：
#   $IMAGEMNTDIR  镜像根分区的挂载点
#   $ARTIFACTDIR  产物目录
set -euo pipefail

ARCH="${1:?用法: collect-kernel.sh <arch>}"
MNT="${IMAGEMNTDIR:?缺少 IMAGEMNTDIR}"
OUT="${ARTIFACTDIR:?缺少 ARTIFACTDIR}"

KERNEL="$(ls -1 "$MNT"/boot/vmlinuz-* 2>/dev/null | sort -V | tail -1)"
INITRD="$(ls -1 "$MNT"/boot/initrd.img-* 2>/dev/null | sort -V | tail -1)"

if [ -z "$KERNEL" ] || [ -z "$INITRD" ]; then
  echo "collect-kernel: 找不到内核或 initramfs（kernel='$KERNEL' initrd='$INITRD'）" >&2
  exit 1
fi

cp -f "$KERNEL" "$OUT/vmlinuz-$ARCH"
cp -f "$INITRD" "$OUT/initrd-$ARCH.img"

ls -l "$OUT/vmlinuz-$ARCH" "$OUT/initrd-$ARCH.img"
echo "collect-kernel: 完成（$(basename "$KERNEL") / $(basename "$INITRD")）"
