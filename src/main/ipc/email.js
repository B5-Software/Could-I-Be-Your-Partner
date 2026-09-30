/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerEmailIpc({
  ipcMain,
  emailService,
  getSettings,
  persistSettings,
  getMainWindow,
}) {
  ipcMain.handle('email:generateTOTP', async () => {
    try {
      return { ok: true, ...(await emailService.generateTOTPSecret()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:saveTOTPSecret', async (_, secret) => {
    try {
      getSettings().email.totpSecret = secret;
      persistSettings();
      emailService.configure(getSettings().email);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:verifyTOTP', async (_, code) => {
    try {
      emailService.configure(getSettings().email);
      const valid = emailService.verifyTOTP(code);
      return { ok: true, valid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:connect', async () => {
    try {
      emailService.configure(getSettings().email);
      const mode = getSettings().email.mode || 'send-receive';
      let smtpMsg = '跳过',
        imapMsg = '跳过';
      if (mode === 'send-only' || mode === 'send-receive') {
        const smtp = await emailService.initSMTP();
        smtpMsg = smtp.message;
        console.log('[Email] SMTP connected');
      }
      if (mode === 'receive-only' || mode === 'send-receive') {
        const imap = await emailService.connectIMAP();
        imapMsg = imap.message;
        console.log('[Email] IMAP connected');
      }
      emailService.enabled = true;
      return { ok: true, smtp: smtpMsg, imap: imapMsg };
    } catch (e) {
      console.error('[Email] Connect error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:disconnect', async () => {
    try {
      await emailService.disconnect();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:send', async (_, to, subject, html, text) => {
    try {
      return await emailService.sendEmail(to, subject, html, text);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:fetchNew', async () => {
    try {
      const emails = await emailService.fetchNewEmails();
      return { ok: true, emails };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:startPolling', async () => {
    try {
      const mode = getSettings().email.mode || 'send-receive';
      if (!emailService.enabled) {
        emailService.configure(getSettings().email);
        if (mode === 'send-only' || mode === 'send-receive') {
          await emailService.initSMTP();
          console.log('[Email] SMTP connected for polling start');
        }
        if (mode === 'receive-only' || mode === 'send-receive') {
          await emailService.connectIMAP();
          console.log('[Email] IMAP connected for polling start');
        }
        emailService.enabled = true;
      }
      if (mode === 'send-only') {
        return { ok: true, message: '只发模式，无需轮询' };
      }
      emailService.onEmailReceived = (email) => {
        console.log('[Email] Received email from:', email.from, 'subject:', email.subject);
        if (getMainWindow() && !getMainWindow().isDestroyed()) {
          getMainWindow().webContents.send('email:received', email);
        }
      };
      emailService.startPolling();
      return { ok: true, message: '邮件轮询已启动' };
    } catch (e) {
      console.error('[Email] Start polling error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:stopPolling', async () => {
    try {
      emailService.stopPolling();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:requestApproval', async (_, toolName, args, chatMarkdown) => {
    try {
      const mode = getSettings().email.mode || 'send-receive';
      if (mode === 'receive-only') {
        console.log('[Email] Cannot send approval request in receive-only mode, rejecting');
        return {
          ok: false,
          approved: false,
          reason: '邮件模式为只收，无法发送审批请求，已拒绝',
        };
      }
      if (!emailService.enabled) {
        emailService.configure(getSettings().email);
        await emailService.initSMTP();
        if (mode === 'send-receive') await emailService.connectIMAP();
        emailService.enabled = true;
      }
      if (mode === 'send-only') {
        // Can send but cannot receive reply => auto-reject
        console.log('[Email] Send-only mode cannot receive approval reply, rejecting tool');
        return {
          ok: false,
          approved: false,
          reason: '邮件模式为只发，无法接收审批回复，已拒绝',
        };
      }
      return await emailService.requestApprovalViaEmail(toolName, args, chatMarkdown);
    } catch (e) {
      console.error('[Email] Request approval error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:sendConversation', async (_, messages, title) => {
    try {
      const mode = getSettings().email.mode || 'send-receive';
      if (mode === 'receive-only') {
        console.log('[Email] Cannot send conversation in receive-only mode');
        return { ok: false, error: '邮件模式为只收，无法发送对话摘要' };
      }
      if (!emailService.enabled) {
        emailService.configure(getSettings().email);
        await emailService.initSMTP();
        emailService.enabled = true;
      }
      return await emailService.sendConversationSummary(messages, title);
    } catch (e) {
      console.error('[Email] Send conversation error:', e);
      return { ok: false, error: e.message };
    }
  });

  // ---- FediKitten Service IPC ----

  return {};
};
