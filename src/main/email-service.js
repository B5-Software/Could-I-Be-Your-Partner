/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Email service: IMAP receive + SMTP send
 * TOTP-based authentication for email control
 */

const nodemailer = require('nodemailer');
const imapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');
const { TOTP, Secret } = require('otpauth');
const QRCode = require('qrcode');
const crypto = require('crypto');

class EmailService {
  constructor() {
    this.config = null;       // { smtp, imap, fromAddress, ownerAddress, totpSecret }
    this.transporter = null;  // nodemailer SMTP
    this.imapConnection = null;
    this.polling = false;
    this.pollTimer = null;
    this.onEmailReceived = null; // callback(subject, textBody, fromAddr)
    this.lastSeenUID = 0;
    this.enabled = false;
  }

  // ---- Configuration ----

  configure(emailSettings) {
    this.config = {
      smtp: {
        host: emailSettings.smtpHost,
        port: parseInt(emailSettings.smtpPort) || 587,
        secure: emailSettings.smtpSecure !== false, // default TLS
        auth: {
          user: emailSettings.emailUser,
          pass: emailSettings.emailPass,
        },
      },
      imap: {
        imap: {
          user: emailSettings.emailUser,
          password: emailSettings.emailPass,
          host: emailSettings.imapHost,
          port: parseInt(emailSettings.imapPort) || 993,
          tls: emailSettings.imapTls !== false,
          authTimeout: 10000,
          tlsOptions: { rejectUnauthorized: false },
        },
      },
      fromAddress: emailSettings.emailUser,
      ownerAddress: emailSettings.ownerAddress,
      totpSecret: emailSettings.totpSecret || null,
      pollInterval: (parseInt(emailSettings.pollInterval) || 30) * 1000, // default 30s
      approvalTimeout: parseInt(emailSettings.approvalResendMinutes) || 5,     // TOTP validity window in minutes
      maxResends: parseInt(emailSettings.maxResends) || 3,
      resendInterval: (parseInt(emailSettings.resendIntervalMinutes) || 30) * 60 * 1000,
    };
  }

  // ---- TOTP ----

  /**
   * Generate a new TOTP secret and return the provisioning URI + QR code data URL
   */
  async generateTOTPSecret(accountName = 'CIBYP-Email') {
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: 'CouldIBeYourPartner',
      label: accountName,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    const uri = totp.toString();
    const qrDataUrl = await QRCode.toDataURL(uri);

    return {
      secret: secret.base32,
      uri,
      qrDataUrl,
    };
  }

  /**
   * Verify a TOTP code, allowing for time drift within windowMinutes
   */
  verifyTOTP(code, windowMinutes = 5) {
    if (!this.config?.totpSecret) return false;

    const totp = new TOTP({
      issuer: 'CouldIBeYourPartner',
      label: 'CIBYP-Email',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(this.config.totpSecret),
    });

    // Check with window = windowMinutes * 60 / 30 (number of 30s periods)
    const windowSteps = Math.ceil((windowMinutes * 60) / 30);
    const delta = totp.validate({ token: code.trim(), window: windowSteps });
    return delta !== null;
  }

  /**
   * Generate current TOTP code (for display/testing)
   */
  getCurrentTOTP() {
    if (!this.config?.totpSecret) return null;
    const totp = new TOTP({
      issuer: 'CouldIBeYourPartner',
      label: 'CIBYP-Email',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(this.config.totpSecret),
    });
    return totp.generate();
  }

  // ---- SMTP Send ----

  async initSMTP() {
    if (!this.config) throw new Error('邮箱未配置');
    this.transporter = nodemailer.createTransport(this.config.smtp);
    await this.transporter.verify();
    return { ok: true, message: 'SMTP连接成功' };
  }

  async sendEmail(to, subject, htmlBody, textBody) {
    if (!this.transporter) await this.initSMTP();
    const info = await this.transporter.sendMail({
      from: this.config.fromAddress,
      to,
      subject,
      html: htmlBody,
      text: textBody || htmlBody.replace(/<[^>]+>/g, ''),
    });
    return { ok: true, messageId: info.messageId };
  }

  // ---- IMAP Receive ----

  async connectIMAP() {
    if (!this.config) throw new Error('邮箱未配置');
    console.log('[Email] Connecting IMAP to', this.config.imap.imap.host + ':' + this.config.imap.imap.port, 'user:', this.config.imap.imap.user, 'tls:', this.config.imap.imap.tls);
    this.imapConnection = await imapSimple.connect(this.config.imap);
    await this.imapConnection.openBox('INBOX');
    console.log('[Email] IMAP connected and INBOX opened');
    return { ok: true, message: 'IMAP连接成功' };
  }

  async fetchNewEmails() {
    if (!this.imapConnection) {
      console.log('[Email] No IMAP connection, connecting...');
      await this.connectIMAP();
    }

    try {
      // Search for unseen emails
      const searchCriteria = ['UNSEEN'];
      if (this.config.ownerAddress) {
        searchCriteria.push(['FROM', this.config.ownerAddress]);
      }
      console.log('[Email] Searching IMAP with criteria:', JSON.stringify(searchCriteria));

      const fetchOptions = { bodies: [''], markSeen: true };
      const messages = await this.imapConnection.search(searchCriteria, fetchOptions);
      console.log('[Email] Found', messages.length, 'new messages');

      const results = [];
      for (const msg of messages) {
        const all = msg.parts.find(p => p.which === '');
        if (!all) {
          console.log('[Email] Message has no body part, skipping UID:', msg.attributes?.uid);
          continue;
        }
        const parsed = await simpleParser(all.body);
        console.log('[Email] Parsed message UID:', msg.attributes?.uid, 'from:', parsed.from?.text, 'subject:', parsed.subject);
        results.push({
          uid: msg.attributes.uid,
          from: parsed.from?.text || '',
          subject: parsed.subject || '',
          text: parsed.text || '',
          html: parsed.html || '',
          date: parsed.date,
        });
      }

      return results;
    } catch (e) {
      // Reconnect on error
      console.error('[Email] IMAP fetch error:', e.message, '- stack:', e.stack);
      try {
        console.log('[Email] Attempting IMAP reconnect...');
        this.imapConnection = null;
        await this.connectIMAP();
        console.log('[Email] IMAP reconnected successfully');
      } catch (re) {
        console.error('[Email] IMAP reconnect failed:', re.message);
      }
      return [];
    }
  }

  // ---- Polling ----

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    this._poll();
  }

  stopPolling() {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async _poll() {
    if (!this.polling) return;
    try {
      console.log('[Email] Polling for new emails...');
      const emails = await this.fetchNewEmails();
      for (const email of emails) {
        console.log('[Email] Poll: dispatching email from', email.from, '-', email.subject);
        if (this.onEmailReceived) {
          this.onEmailReceived(email);
        }
      }
      if (emails.length === 0) console.log('[Email] Poll: no new emails');
    } catch (e) {
      console.error('[Email] Poll error:', e.message);
    }
    if (this.polling) {
      this.pollTimer = setTimeout(() => this._poll(), this.config?.pollInterval || 30000);
    }
  }

  // ---- Approval via Email ----

  /**
   * Send approval request email with TOTP prompt
   * Returns a Promise that resolves with {approved, code} when user replies
   * Will re-send up to maxResends times every resendInterval if no reply
   */
  async requestApprovalViaEmail(toolName, args, chatSummaryMarkdown) {
    const subject = `[CIBYP审批] 敏感操作审批请求 - ${toolName}`;
    const htmlBody = `
      <h2>敏感操作审批请求</h2>
      <p>AI Agent 需要执行以下敏感操作，请审批：</p>
      <table border="1" cellpadding="8" style="border-collapse:collapse;max-width:600px">
        <tr><td><b>工具名称</b></td><td>${escapeHtml(toolName)}</td></tr>
        <tr><td><b>参数</b></td><td><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></td></tr>
      </table>
      <h3>当前对话上下文</h3>
      <div style="background:#f5f5f5;padding:12px;border-radius:4px;max-height:400px;overflow:auto;font-size:13px;white-space:pre-wrap">${escapeHtml(chatSummaryMarkdown)}</div>
      <hr>
      <h3>审批方式</h3>
      <p>请直接回复此邮件，在正文中输入你的 <b>6位 TOTP 验证码</b> 来批准此操作。</p>
      <p>如果要拒绝，请回复 <b>拒绝</b> 或 <b>reject</b>。</p>
      <p style="color:#888;font-size:12px">验证码有效期 ${this.config?.approvalTimeout || 5} 分钟 | 此邮件由 Could I Be Your Partner 自动发送</p>
    `;

    return new Promise((resolve) => {
      let resendCount = 0;
      let resolved = false;

      const sendRequest = async () => {
        try {
          await this.sendEmail(this.config.ownerAddress, subject, htmlBody);
          console.log(`[Email] Approval request sent (attempt ${resendCount + 1})`);
        } catch (e) {
          console.error('[Email] Failed to send approval request:', e.message);
        }
      };

      // Send initial request
      sendRequest();

      // Set up resend timer
      const resendTimer = setInterval(async () => {
        if (resolved) { clearInterval(resendTimer); return; }
        resendCount++;
        if (resendCount >= (this.config?.maxResends || 3)) {
          clearInterval(resendTimer);
          // Don't resolve - keep waiting for reply, just stop resending
          return;
        }
        await sendRequest();
      }, this.config?.resendInterval || 30 * 60 * 1000);

      // Set up reply checker
      const checkReply = async () => {
        if (resolved) return;
        try {
          const emails = await this.fetchNewEmails();
          for (const email of emails) {
            // Check if this is a reply to our approval request
            if (email.subject?.includes('审批') || email.subject?.includes(toolName) || email.subject?.includes('Re:')) {
              const body = (email.text || '').trim();

              // Check for rejection
              if (/^(拒绝|reject|no|否|不)$/i.test(body)) {
                resolved = true;
                clearInterval(resendTimer);
                // Send confirmation
                await this.sendEmail(this.config.ownerAddress, `[CIBYP] 审批已拒绝 - ${toolName}`,
                  `<p>操作 <b>${escapeHtml(toolName)}</b> 已被拒绝。</p>`);
                resolve({ approved: false, reason: '用户通过邮件拒绝' });
                return;
              }

              // Try to extract and verify TOTP code
              const codeMatch = body.match(/\b(\d{6})\b/);
              if (codeMatch) {
                const code = codeMatch[1];
                if (this.verifyTOTP(code, this.config?.approvalTimeout || 5)) {
                  resolved = true;
                  clearInterval(resendTimer);
                  await this.sendEmail(this.config.ownerAddress, `[CIBYP] 审批成功 - ${toolName}`,
                    `<p>验证码正确，操作 <b>${escapeHtml(toolName)}</b> 已批准执行。</p>`);
                  resolve({ approved: true });
                  return;
                } else {
                  // Wrong code - ask retry
                  await this.sendEmail(this.config.ownerAddress, `[CIBYP] 验证码错误 - ${toolName}`,
                    `<p>验证码 <b>${code}</b> 无效或已过期。</p><p>请重新回复正确的6位验证码，或回复 <b>拒绝</b> 来取消操作。</p>`);
                }
              }
            }
          }
        } catch (e) {
          console.error('[Email] Reply check error:', e.message);
        }
        if (!resolved) {
          setTimeout(checkReply, 15000); // Check every 15s
        }
      };

      // Start checking replies after a delay
      setTimeout(checkReply, 10000);
    });
  }

  // ---- Conversation Summary ----

  async sendConversationSummary(messages, conversationTitle) {
    if (!this.config?.ownerAddress) return { ok: false, error: '未设置用户邮箱地址' };

    const markdown = this._messagesToMarkdown(messages, conversationTitle);
    const htmlBody = this._markdownToSimpleHtml(markdown);

    return await this.sendEmail(
      this.config.ownerAddress,
      `[CIBYP] 对话记录 - ${conversationTitle || '未命名'}`,
      htmlBody,
      markdown
    );
  }

  _messagesToMarkdown(messages, title) {
    let md = `# ${title || '对话记录'}\n\n`;
    md += `_生成时间: ${new Date().toLocaleString('zh-CN')}_\n\n---\n\n`;

    for (const msg of messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'user') {
        md += `## 用户\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        if (msg.content) {
          md += `## AI\n\n${msg.content}\n\n`;
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            md += `> 调用工具: \`${tc.function.name}\`\n`;
            try {
              const args = JSON.parse(tc.function.arguments || '{}');
              md += `> 参数: \`${JSON.stringify(args)}\`\n\n`;
            } catch {
              md += `> 参数: \`${tc.function.arguments}\`\n\n`;
            }
          }
        }
      } else if (msg.role === 'tool') {
        md += `> 工具结果: \`${(msg.content || '').substring(0, 200)}${msg.content?.length > 200 ? '...' : ''}\`\n\n`;
      }
    }

    return md;
  }

  _markdownToSimpleHtml(md) {
    return md
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/_(.+?)_/g, '<i>$1</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n{2,}/g, '<br><br>')
      .replace(/---/g, '<hr>')
      .replace(/\n/g, '<br>');
  }

  // ---- Cleanup ----

  async disconnect() {
    this.stopPolling();
    if (this.imapConnection) {
      try { this.imapConnection.end(); } catch { /* ignore */ }
      this.imapConnection = null;
    }
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
    this.enabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { EmailService };
