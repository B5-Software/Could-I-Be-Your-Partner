#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 B5-Software
#
# CIBYP-VM-OS 收尾脚本：必须由 tail.yaml 在**所有 apt 安装之后**、pack 之前执行。
# 出厂干净化 + 体积清理都在这里（setup.sh 里做会被后续 apt 安装重新搞脏，实测 base 因此多出 ~200MB）。
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "[cibyp] finalize: 清理与出厂化"

# ---- 体积清理 ----
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /var/lib/dpkg/info/*.md5sums 2>/dev/null || true
# man 页与 groff 文档（保留 /usr/share/doc 下的版权文件：Debian 分发合规要求）
rm -rf /usr/share/man/* /usr/share/groff /usr/share/info/* 2>/dev/null || true
find /usr/share/doc -type f \( -name 'changelog*' -o -name 'NEWS*' -o -name 'README*' \) -delete 2>/dev/null || true
rm -rf /tmp/* /var/tmp/* /root/.cache /root/.npm 2>/dev/null || true
find /var/log -type f -exec truncate -s 0 {} \; 2>/dev/null || true
# 内核模块之外的调试符号（若被装上）
rm -rf /usr/lib/debug 2>/dev/null || true

# ---- 出厂干净化（每台实例首启重新生成） ----
: > /etc/machine-id
rm -f /etc/ssh/ssh_host_* 2>/dev/null || true
rm -rf /var/lib/cloud/* 2>/dev/null || true
rm -rf /etc/cloud/cloud.cfg.d/90_* 2>/dev/null || true
rm -f /var/lib/dbus/machine-id 2>/dev/null || true
# 实例日志与临时状态
rm -f /etc/resolv.conf.bak /root/.bash_history 2>/dev/null || true

# 清掉 overlay 里可能残留的实例数据（/workspace 由 cloud-init 首启创建）
rm -rf /workspace/* 2>/dev/null || true

echo "[cibyp] finalize: 完成（镜像体积与出厂状态已就绪）"
du -sh / 2>/dev/null | tail -1 || true
