/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * cibyp-sandbox.exe —— Windows 受限令牌 ACL 沙箱后端。
 *
 * 原理（与 docs/deepseek-compat/02-sandbox.md 的语义对齐，只约束文件效果）：
 *   1. 从当前进程令牌派生受限令牌：CreateRestrictedToken 删除全部特权
 *      （DISABLE_MAX_PRIVILEGE + SANDBOX_INERT）；
 *   2. 将受限令牌的强制完整性级别（MIC）降为 Low（S-1-16-4096）。
 *      低完整性进程可以"读"Medium 对象（向下读允许），但"写"Medium 对象
 *      会被 MIC 拒绝 —— 即"只读"语义（无需改动任何既有 ACL）；
 *   3. workspace-write：把工作区目录树递归打上 Low 强制标签
 *      （SACL 增加 SYSTEM_MANDATORY_LABEL_ACE），子进程即可在工作区内
 *      任意读写，区外写入仍被 MIC 拒绝；同时将子进程 TMP/TEMP 指到
 *      一个低标签临时目录；
 *   4. CreateProcessAsUser 以受限令牌创建子进程（继承 stdio / fork IPC
 *      句柄），Job 对象 KILL_ON_JOB_CLOSE 保证包装器退出时子进程树一并终止。
 *
 * fail-closed：任何前置步骤失败都不启动子进程，stderr 输出
 * "cibyp-sandbox: ..." 并以非零码退出。
 *
 * 用法：
 *   cibyp-sandbox.exe --mode <read-only|workspace-write>
 *                      [--workspace <dir>] [--temp <dir>] -- <exe> <args...>
 *   cibyp-sandbox.exe --self-test
 *
 * 构建（x64，MinGW-w64）：
 *   gcc -O2 -s -municode cibyp-sandbox.c -o cibyp-sandbox.exe -ladvapi32
 */

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

/* stderr 转 UTF-8 输出，保证中文诊断在管道/终端均可见。 */
static void init_utf8_stderr(void) {
  static int done = 0;
  if (done) return;
  done = 1;
  _setmode(_fileno(stderr), _O_U8TEXT);
}

#define LOW_INTEGRITY_SID L"S-1-16-4096"
#define MANDATORY_LABEL_NO_WRITE_UP 0x00000001
#define WRAPPER_TAG L"cibyp-sandbox: "

static void fatal(const wchar_t *what) {
  init_utf8_stderr();
  fwprintf(stderr, L"%ls%ls failed (error %lu)\n", WRAPPER_TAG, what, GetLastError());
}

static void log_msg(const wchar_t *msg) {
  init_utf8_stderr();
  fwprintf(stderr, L"%ls%ls\n", WRAPPER_TAG, msg);
}

/* ------------------------------------------------------------------ */
/* 受限令牌                                                             */
/* ------------------------------------------------------------------ */

/* 创建受限令牌：删光特权 + 沙箱惰性标记 + 降为 Low 完整性。 */
static HANDLE create_restricted_token(void) {
  HANDLE hTok = NULL, hRestricted = NULL;

  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY |
                          TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID,
                        &hTok)) {
    fatal(L"OpenProcessToken");
    return NULL;
  }
  if (!CreateRestrictedToken(hTok, DISABLE_MAX_PRIVILEGE | SANDBOX_INERT,
                             0, NULL, 0, NULL, 0, NULL, &hRestricted)) {
    fatal(L"CreateRestrictedToken");
    CloseHandle(hTok);
    return NULL;
  }
  CloseHandle(hTok);

  PSID pLow = NULL;
  if (!ConvertStringSidToSidW(LOW_INTEGRITY_SID, &pLow)) {
    fatal(L"ConvertStringSidToSidW");
    CloseHandle(hRestricted);
    return NULL;
  }
  TOKEN_MANDATORY_LABEL tml;
  tml.Label.Attributes = SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED;
  tml.Label.Sid = pLow;
  if (!SetTokenInformation(hRestricted, TokenIntegrityLevel, &tml,
                           sizeof(tml))) {
    fatal(L"SetTokenInformation(TokenIntegrityLevel)");
    LocalFree(pLow);
    CloseHandle(hRestricted);
    return NULL;
  }
  LocalFree(pLow);
  return hRestricted;
}

/* 启用当前进程令牌中的指定特权（CreateProcessAsUser 需要）。 */
static void enable_privilege(HANDLE hTok, const wchar_t *name) {
  TOKEN_PRIVILEGES tp;
  LUID luid;
  if (!LookupPrivilegeValueW(NULL, name, &luid)) return;
  tp.PrivilegeCount = 1;
  tp.Privileges[0].Luid = luid;
  tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  AdjustTokenPrivileges(hTok, FALSE, &tp, 0, NULL, NULL);
}

/* ------------------------------------------------------------------ */
/* 完整性标签（SACL）维护                                               */
/* ------------------------------------------------------------------ */

/* 路径 -> \\?\ 长路径形式（供递归枚举使用）；折叠重复分隔符。 */
static wchar_t *long_path(const wchar_t *p) {
  size_t n = wcslen(p);
  wchar_t *tmp = (wchar_t *)malloc((n + 8) * sizeof(wchar_t));
  if (!tmp) return NULL;
  const wchar_t *s = p;
  wchar_t *d = tmp;
  if (wcsncmp(p, L"\\\\?\\", 4) == 0) s += 4;
  while (*s) {
    if (*s == L'\\' && d > tmp && d[-1] == L'\\') {
      s++;
      continue;
    }
    *d++ = *s++;
  }
  *d = L'\0';
  size_t m = wcslen(tmp);
  wchar_t *out = (wchar_t *)malloc((m + 5) * sizeof(wchar_t));
  if (!out) {
    free(tmp);
    return NULL;
  }
  swprintf(out, m + 5, L"\\\\?\\%ls", tmp);
  free(tmp);
  return out;
}

/* 检查对象 SACL 中是否已有 Low 强制标签 ACE。 */
static BOOL has_low_label(PACL psacl) {
  if (!psacl) return FALSE;
  ACL_SIZE_INFORMATION info;
  if (!GetAclInformation(psacl, &info, sizeof(info), AclSizeInformation))
    return FALSE;
  for (DWORD i = 0; i < info.AceCount; i++) {
    LPVOID ace = NULL;
    if (!GetAce(psacl, i, &ace)) continue;
    ACE_HEADER *hdr = (ACE_HEADER *)ace;
    if (hdr->AceType == SYSTEM_MANDATORY_LABEL_ACE_TYPE) {
      SYSTEM_MANDATORY_LABEL_ACE *ml = (SYSTEM_MANDATORY_LABEL_ACE *)ace;
      PSID sid = (PSID)&ml->SidStart;
      if (IsWellKnownSid(sid, WinLowLabelSid)) return TRUE;
    }
  }
  return FALSE;
}

/*
 * 把单个对象（文件/目录）的强制完整性标签改为 Low。
 * 使用 LABEL_SECURITY_INFORMATION（而非 SACL）：普通用户无需
 * SeSecurityPrivilege 即可读写强制标签（与 icacls /setintegritylevel 一致）。
 * 返回：1=对象原本已是 Low（未改动）；0=已成功改为 Low；-1=失败（跳过）。
 */
static int set_low_label_internal(const wchar_t *lp) {
  PSECURITY_DESCRIPTOR psd = NULL;
  PACL plabel = NULL;

  DWORD err = GetNamedSecurityInfoW(lp, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
                                    NULL, NULL, NULL, &plabel, &psd);
  if (getenv("CIBYP_DEBUG_LABEL")) log_msg(L"GetNamedSecurityInfoW -> err");
  if (err != ERROR_SUCCESS) {
    if (getenv("CIBYP_DEBUG_LABEL")) {
      wchar_t dbg[256];
      _snwprintf(dbg, 256, L"label-debug: GetNamedSecurityInfoW error=%lu path=%ls", err, lp);
      log_msg(dbg);
    }
    return -1;
  }
  if (has_low_label(plabel)) {
    LocalFree(psd);
    return 1;
  }

  /* 构造仅含 Low 标签 ACE 的新 ACL（LABEL 标志下整体替换强制标签）。 */
  PSID pLow = NULL;
  if (!ConvertStringSidToSidW(LOW_INTEGRITY_SID, &pLow)) {
    LocalFree(psd);
    return -1;
  }

  DWORD aclLen = sizeof(ACL) + sizeof(SYSTEM_MANDATORY_LABEL_ACE) - sizeof(DWORD) +
                 GetLengthSid(pLow);
  PACL pNewAcl = (PACL)malloc(aclLen);
  if (!pNewAcl) {
    LocalFree(pLow);
    LocalFree(psd);
    return -1;
  }
  if (!InitializeAcl(pNewAcl, aclLen, ACL_REVISION)) {
    free(pNewAcl);
    LocalFree(pLow);
    LocalFree(psd);
    return -1;
  }
  /* SYSTEM_MANDATORY_LABEL_ACE 是变长结构：SidStart 之后紧跟 SID 本体，
     必须在堆上整体分配（栈上定长结构 + memcpy 会越界写坏栈）。 */
  DWORD sidLen = GetLengthSid(pLow);
  DWORD aceSize = (DWORD)(sizeof(SYSTEM_MANDATORY_LABEL_ACE) - sizeof(DWORD) + sidLen);
  SYSTEM_MANDATORY_LABEL_ACE *mlAce =
      (SYSTEM_MANDATORY_LABEL_ACE *)calloc(1, aceSize);
  if (!mlAce) {
    LocalFree(pLow);
    LocalFree(psd);
    return -1;
  }
  mlAce->Header.AceType = SYSTEM_MANDATORY_LABEL_ACE_TYPE;
  mlAce->Header.AceFlags = 0;
  mlAce->Header.AceSize = (WORD)aceSize;
  mlAce->Mask = MANDATORY_LABEL_NO_WRITE_UP;
  memcpy(&mlAce->SidStart, pLow, sidLen);
  BOOL ok = AddAce(pNewAcl, ACL_REVISION, MAXDWORD, mlAce, aceSize);
  free(mlAce);

  if (ok) {
    err = SetNamedSecurityInfoW((LPWSTR)lp, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
                                NULL, NULL, NULL, pNewAcl);
    if (getenv("CIBYP_DEBUG_LABEL")) {
      wchar_t dbg[256];
      _snwprintf(dbg, 256, L"label-debug: SetNamedSecurityInfoW error=%lu path=%ls", err, lp);
      log_msg(dbg);
    }
    ok = (err == ERROR_SUCCESS);
  }
  free(pNewAcl);
  LocalFree(pLow);
  LocalFree(psd);
  return ok ? 0 : -1;
}

/*
 * 递归打 Low 标签。
 * 快速路径：根目录已是 Low（子树此前已递归处理过）→ 直接返回，不再遍历；
 * 否则根打标签成功后遍历整树（跳过重解析点，单项失败不中断）。
 */
static BOOL label_low_recursive(const wchar_t *root) {
  wchar_t *lp = long_path(root);
  if (!lp) return FALSE;
  int r = set_low_label_internal(lp);
  if (r < 0) {
    free(lp);
    return FALSE;
  }
  if (r == 1) {
    free(lp);
    return TRUE; /* 快速路径 */
  }

  wchar_t pattern[MAX_PATH * 2];
  _snwprintf(pattern, MAX_PATH * 2, L"%ls\\*", lp);
  WIN32_FIND_DATAW fd;
  HANDLE hFind = FindFirstFileW(pattern, &fd);
  if (hFind != INVALID_HANDLE_VALUE) {
    do {
      if (fd.cFileName[0] == L'.' &&
          (fd.cFileName[1] == L'\0' ||
           (fd.cFileName[1] == L'.' && fd.cFileName[2] == L'\0')))
        continue;
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;
      wchar_t child[MAX_PATH * 2];
      _snwprintf(child, MAX_PATH * 2, L"%ls\\%ls", lp, fd.cFileName);
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        label_low_recursive(child);
      } else {
        set_low_label_internal(child);
      }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
  }
  free(lp);
  return TRUE;
}

/* ------------------------------------------------------------------ */
/* 子进程启动                                                           */
/* ------------------------------------------------------------------ */

/* Windows 命令行引用（MSDN 规则）。 */
static wchar_t *quote_arg(const wchar_t *arg) {
  BOOL needQuote = (wcslen(arg) == 0 ||
                    wcspbrk(arg, L" \t\"") != NULL);
  if (!needQuote) return _wcsdup(arg);
  size_t n = wcslen(arg);
  wchar_t *out = (wchar_t *)malloc((n * 2 + 3) * sizeof(wchar_t));
  if (!out) return NULL;
  wchar_t *p = out;
  *p++ = L'"';
  const wchar_t *s = arg;
  while (*s) {
    DWORD backslashes = 0;
    while (*s == L'\\') { backslashes++; s++; }
    if (*s == L'"') {
      for (DWORD i = 0; i < backslashes * 2 + 1; i++) *p++ = L'\\';
      *p++ = *s++;
    } else {
      for (DWORD i = 0; i < backslashes; i++) *p++ = L'\\';
      if (*s) *p++ = *s++;
    }
  }
  *p++ = L'"';
  *p = L'\0';
  return out;
}

/* 重建子进程命令行（wrapper argv[argc..] -> 单条命令行）。 */
static wchar_t *build_command_line(int argc, wchar_t **argv, int start) {
  size_t total = 0;
  int n = argc - start;
  wchar_t **quoted = (wchar_t **)malloc((size_t)n * sizeof(wchar_t *));
  if (!quoted) return NULL;
  for (int i = 0; i < n; i++) {
    quoted[i] = quote_arg(argv[start + i]);
    if (!quoted[i]) {
      while (i > 0) free(quoted[--i]);
      free(quoted);
      return NULL;
    }
    total += wcslen(quoted[i]) + 1;
  }
  wchar_t *cmd = (wchar_t *)malloc((total + 1) * sizeof(wchar_t));
  if (!cmd) {
    for (int i = 0; i < n; i++) free(quoted[i]);
    free(quoted);
    return NULL;
  }
  cmd[0] = L'\0';
  for (int i = 0; i < n; i++) {
    if (i > 0) wcscat(cmd, L" ");
    wcscat(cmd, quoted[i]);
    free(quoted[i]);
  }
  free(quoted);
  return cmd;
}

/* 环境块：把 TMP/TEMP 替换为 scratch 目录。 */
static wchar_t *build_env_block(const wchar_t *scratch) {
  wchar_t *src = GetEnvironmentStringsW();
  if (!src) return NULL;
  size_t cap = 4096, used = 0;
  wchar_t *out = (wchar_t *)malloc(cap * sizeof(wchar_t));
  if (!out) {
    FreeEnvironmentStringsW(src);
    return NULL;
  }
  out[0] = L'\0';
  BOOL replacedTmp = FALSE, replacedTemp = FALSE;
  wchar_t *cur = src;
  while (*cur) {
    size_t len = wcslen(cur);
    BOOL isTmp = (_wcsnicmp(cur, L"TMP=", 4) == 0);
    BOOL isTemp = (_wcsnicmp(cur, L"TEMP=", 5) == 0);
    size_t addLen;
    if (isTmp) {
      addLen = 4 + wcslen(scratch) + 1;
      replacedTmp = TRUE;
    } else if (isTemp) {
      addLen = 5 + wcslen(scratch) + 1;
      replacedTemp = TRUE;
    } else {
      addLen = len + 1;
    }
    while (used + addLen + 1 > cap) {
      cap *= 2;
      wchar_t *nb = (wchar_t *)realloc(out, cap * sizeof(wchar_t));
      if (!nb) {
        free(out);
        FreeEnvironmentStringsW(src);
        return NULL;
      }
      out = nb;
    }
    if (isTmp) {
      wcscpy(out + used, L"TMP=");
      wcscat(out + used, scratch);
    } else if (isTemp) {
      wcscpy(out + used, L"TEMP=");
      wcscat(out + used, scratch);
    } else {
      wcscpy(out + used, cur);
    }
    used += addLen - 1;
    out[used] = L'\0';
    used++;
    cur += len + 1;
  }
  while (used + 64 > cap) {
    cap *= 2;
    wchar_t *nb = (wchar_t *)realloc(out, cap * sizeof(wchar_t));
    if (!nb) {
      free(out);
      FreeEnvironmentStringsW(src);
      return NULL;
    }
    out = nb;
  }
  if (!replacedTmp) {
    wcscpy(out + used, L"TMP=");
    wcscat(out + used, scratch);
    used += 4 + wcslen(scratch) + 1;
    out[used] = L'\0';
    used++;
  }
  if (!replacedTemp) {
    wcscpy(out + used, L"TEMP=");
    wcscat(out + used, scratch);
    used += 5 + wcslen(scratch) + 1;
    out[used] = L'\0';
  }
  FreeEnvironmentStringsW(src);
  return out;
}

/* 以受限令牌启动子进程并等待；返回子进程退出码，或 -1（启动失败）。 */
static int launch_confined(HANDLE hRestricted, const wchar_t *cmdline,
                           wchar_t *env) {
  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof(si));
  ZeroMemory(&pi, sizeof(pi));
  si.cb = sizeof(si);
  HANDLE hIn = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE hErr = GetStdHandle(STD_ERROR_HANDLE);
  if ((hIn != NULL && hIn != INVALID_HANDLE_VALUE) ||
      (hOut != NULL && hOut != INVALID_HANDLE_VALUE) ||
      (hErr != NULL && hErr != INVALID_HANDLE_VALUE)) {
    si.dwFlags |= STARTF_USESTDHANDLES;
    si.hStdInput = (hIn && hIn != INVALID_HANDLE_VALUE) ? hIn : NULL;
    si.hStdOutput = (hOut && hOut != INVALID_HANDLE_VALUE) ? hOut : NULL;
    si.hStdError = (hErr && hErr != INVALID_HANDLE_VALUE) ? hErr : NULL;
  }
  /* CreateProcess 会就地改写 lpCommandLine（如整理引号），因此必须传入
     可写缓冲区：字符串字面量位于只读段，传入会在写时触发访问冲突。 */
  wchar_t *cmdCopy = _wcsdup(cmdline);
  if (!cmdCopy) return -1;
  if (!CreateProcessAsUserW(hRestricted, NULL, cmdCopy, NULL, NULL,
                            TRUE, CREATE_UNICODE_ENVIRONMENT, env, NULL,
                            &si, &pi)) {
    free(cmdCopy);
    return -1;
  }
  free(cmdCopy);
  /* Job 对象：包装器退出（含被 kill/超时）时整棵子进程树一并终止。 */
  HANDLE hJob = CreateJobObjectW(NULL, NULL);
  if (hJob) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
    ZeroMemory(&jeli, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jeli,
                            sizeof(jeli));
    AssignProcessToJobObject(hJob, pi.hProcess);
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  if (hJob) CloseHandle(hJob);
  return (int)code;
}

/* 核心：以受限令牌启动子进程并等待，返回子进程退出码。 */
static int run_confined(int argc, wchar_t **argv, int start,
                        const wchar_t *mode, const wchar_t *workspace,
                        const wchar_t *scratch) {
  HANDLE hRestricted = create_restricted_token();
  if (!hRestricted) return 127;

  HANDLE hSelf = NULL;
  OpenProcessToken(GetCurrentProcess(),
                   TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hSelf);
  if (hSelf) {
    enable_privilege(hSelf, L"SeAssignPrimaryTokenPrivilege");
    enable_privilege(hSelf, L"SeIncreaseQuotaPrivilege");
    CloseHandle(hSelf);
  }

  if (wcscmp(mode, L"workspace-write") == 0) {
    if (workspace && *workspace) {
      if (!label_low_recursive(workspace)) {
        log_msg(L"无法为工作区设置低完整性标签，拒绝执行（fail-closed）");
        CloseHandle(hRestricted);
        return 127;
      }
    }
  }

  wchar_t *env = NULL;
  if (scratch && *scratch) {
    if (!CreateDirectoryW(scratch, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) {
      fatal(L"CreateDirectory(scratch)");
      CloseHandle(hRestricted);
      return 127;
    }
    wchar_t *slp = long_path(scratch);
    if (!slp || set_low_label_internal(slp) < 0) {
      if (slp) free(slp);
      log_msg(L"无法为临时目录设置低完整性标签，拒绝执行（fail-closed）");
      CloseHandle(hRestricted);
      return 127;
    }
    free(slp);
    env = build_env_block(scratch);
  }

  wchar_t *cmdline = build_command_line(argc, argv, start);
  if (!cmdline) {
    log_msg(L"命令行为空");
    if (env) free(env);
    CloseHandle(hRestricted);
    return 127;
  }

  int code = launch_confined(hRestricted, cmdline, env);
  free(cmdline);
  if (env) free(env);
  CloseHandle(hRestricted);
  if (code < 0) {
    fatal(L"CreateProcessAsUser");
    return 127;
  }
  return code;
}

/* ------------------------------------------------------------------ */
/* 自检                                                                 */
/* ------------------------------------------------------------------ */

/*
 * 自检全部走 CreateProcessAsUser 真实路径（SANDBOX_INERT 令牌不可用于
 * 进程内 SetThreadToken 模拟，与正式受限执行完全一致）。
 */
static int self_test(void) {
  log_msg(L"self-test: begin");
  HANDLE hRestricted = create_restricted_token();
  log_msg(L"self-test: token ok");
  if (!hRestricted) return 1;

  HANDLE hSelf = NULL;
  OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
                   &hSelf);
  if (hSelf) {
    enable_privilege(hSelf, L"SeAssignPrimaryTokenPrivilege");
    enable_privilege(hSelf, L"SeIncreaseQuotaPrivilege");
    CloseHandle(hSelf);
  }
  log_msg(L"self-test: privileges ok");

  wchar_t tmpDir[MAX_PATH], scratch[MAX_PATH], roDir[MAX_PATH];
  DWORD len = GetTempPathW(MAX_PATH, tmpDir);
  if (len == 0 || len >= MAX_PATH) {
    CloseHandle(hRestricted);
    return 1;
  }
  _snwprintf(scratch, MAX_PATH, L"%ls\\cibyp-selftest-%lu", tmpDir,
             GetCurrentProcessId());
  _snwprintf(roDir, MAX_PATH, L"%ls\\cibyp-selftest-ro-%lu", tmpDir,
             GetCurrentProcessId());
  log_msg(L"self-test: paths ok");

  BOOL failed = FALSE;
  if (CreateDirectoryW(scratch, NULL) == 0 && GetLastError() != ERROR_ALREADY_EXISTS) {
    log_msg(L"self-test: 无法创建临时目录");
    CloseHandle(hRestricted);
    return 1;
  }
  wchar_t *slp = long_path(scratch);
  if (!slp || set_low_label_internal(slp) < 0) {
    log_msg(L"self-test: 临时目录低标签设置失败");
    if (slp) free(slp);
    failed = TRUE;
    goto cleanup;
  }
  free(slp);
  if (CreateDirectoryW(roDir, NULL) == 0 && GetLastError() != ERROR_ALREADY_EXISTS) {
    log_msg(L"self-test: 无法创建只读探测目录");
    failed = TRUE;
    goto cleanup;
  }

  wchar_t ps[MAX_PATH * 2];
  _snwprintf(ps, MAX_PATH * 2, L"%ls\\cibyp-selftest-trace.txt", tmpDir);

  /* 1) 低标签目录内写入必须成功（受限子进程）。 */
  _snwprintf(ps, MAX_PATH * 2,
             L"powershell.exe -NoProfile -NonInteractive -Command \"try { Set-Content -LiteralPath '%ls\\write-ok.txt' -Value 'x' -ErrorAction Stop } catch { exit 4 }\"",
             scratch);
  int c1 = launch_confined(hRestricted, ps, NULL);
  if (c1 != 0) {
    log_msg(L"self-test: 低标签目录内写入被拒绝（应为允许）");
    failed = TRUE;
  }

  /* 2) Medium 目录内写入必须被拒绝（fail-closed 的核心）。 */
  _snwprintf(ps, MAX_PATH * 2,
             L"powershell.exe -NoProfile -NonInteractive -Command \"try { Set-Content -LiteralPath '%ls\\ro-write.txt' -Value 'x' -ErrorAction Stop; exit 3 } catch { exit 0 }\"",
             roDir);
  int c2 = launch_confined(hRestricted, ps, NULL);
  if (c2 != 0) {
    log_msg(L"self-test: Medium 目录内写入未被拒绝（完整性机制不可用）");
    failed = TRUE;
  }

  /* 3) 向下读：Medium 系统文件应可读。 */
  wchar_t sysFile[MAX_PATH];
  GetSystemDirectoryW(sysFile, MAX_PATH);
  _snwprintf(ps, MAX_PATH * 2,
             L"powershell.exe -NoProfile -NonInteractive -Command \"try { [System.IO.File]::ReadAllBytes('%ls\\kernel32.dll') | Out-Null } catch { exit 6 }\"",
             sysFile);
  int c3 = launch_confined(hRestricted, ps, NULL);
  if (c3 != 0) {
    log_msg(L"self-test: 系统文件读取被拒绝（向下读异常）");
    failed = TRUE;
  }

  /* 4) 退出码透传：受限子进程应能运行并返回退出码 7。 */
  _snwprintf(ps, MAX_PATH * 2,
             L"powershell.exe -NoProfile -NonInteractive -Command \"exit 7\"");
  int c4 = launch_confined(hRestricted, ps, NULL);
  if (c4 != 7) {
    log_msg(L"self-test: 受限子进程退出码异常");
    failed = TRUE;
  }

cleanup:
  CloseHandle(hRestricted);
  {
    wchar_t f[MAX_PATH];
    _snwprintf(f, MAX_PATH, L"%ls\\write-ok.txt", scratch);
    DeleteFileW(f);
    _snwprintf(f, MAX_PATH, L"%ls\\ro-write.txt", roDir);
    DeleteFileW(f);
    RemoveDirectoryW(roDir);
    RemoveDirectoryW(scratch);
  }
  if (failed) return 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

int wmain(int argc, wchar_t **argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--self-test") == 0) {
    return self_test();
  }

  const wchar_t *mode = NULL, *workspace = NULL, *scratch = NULL;
  int i = 1, childStart = -1;
  while (i < argc) {
    if (wcscmp(argv[i], L"--mode") == 0 && i + 1 < argc) {
      mode = argv[i + 1]; i += 2;
    } else if (wcscmp(argv[i], L"--workspace") == 0 && i + 1 < argc) {
      workspace = argv[i + 1]; i += 2;
    } else if (wcscmp(argv[i], L"--temp") == 0 && i + 1 < argc) {
      scratch = argv[i + 1]; i += 2;
    } else if (wcscmp(argv[i], L"--") == 0) {
      childStart = i + 1;
      break;
    } else {
      log_msg(L"参数错误（用法: --mode <read-only|workspace-write> [--workspace <dir>] [--temp <dir>] -- <cmd...>）");
      return 127;
    }
  }
  if (childStart < 0 || childStart >= argc || !mode) {
    log_msg(L"缺少 --mode 或子命令");
    return 127;
  }
  if (wcscmp(mode, L"read-only") != 0 && wcscmp(mode, L"workspace-write") != 0) {
    log_msg(L"--mode 必须是 read-only 或 workspace-write");
    return 127;
  }
  return run_confined(argc, argv, childStart, mode, workspace, scratch);
}
