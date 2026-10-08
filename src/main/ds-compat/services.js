/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { Service } = require('@deepseek-ai/cordis');
const { ApprovalService } = require('@deepseek-ai/dsh-user-approval');
const sandbox = require('../sandbox-runner');
const { currentExecution } = require('./execution-context');
class CibypSandboxPolicyService extends Service {
  constructor(ctx, options = {}) {
    super(ctx, 'sandboxPolicy');
    this.options = options;
    this.settings = {};
  }
  async refresh() {
    this.settings = (await this.options.getSettings?.()) || {};
  }
  get defaultMode() {
    return this.settings.sandbox?.defaultMode || 'danger-full-access';
  }
  get workspaceRoot() {
    return currentExecution().cwd || process.cwd();
  }
  overrideOf(session) {
    return session?.snapshotEvents().findLast((event) => event.type === 'sandbox/mode')?.data.mode;
  }
  resolve(request = {}) {
    const execution = currentExecution();
    const agent = this.ctx.root.get('agents')?.get(request.session?.id) || execution.agent;
    const policy = sandbox.policyForCall(
      this.settings,
      agent?.mode || execution.mode || 'chat',
      request.session?.header.cwd || execution.cwd || process.cwd(),
    );
    // A DS plugin cannot relax CIBYP's standing policy by requesting a different mode.
    return { ...policy, ...(request.session ? { sessionId: request.session.id } : {}) };
  }
}
class CibypApprovalService extends ApprovalService {
  constructor(ctx, options = {}) {
    super(ctx, { policy: 'ask' });
    ctx.on('approval/request', async (req, next) => {
      if (!options.transport?.request) return next();
      const result = await options.transport.request(
        'ds:approvalRequest',
        {
          toolName: req.toolName,
          reason: req.reason || '',
          callId: req.callId,
          sessionKey: req.agent.id,
        },
        300000,
        req.signal,
      );
      return result === true || result?.approved === true || result === 'allowed-once'
        ? 'allowed-once'
        : result === 'cancelled'
          ? 'cancelled'
          : 'rejected';
    });
  }
}
module.exports = {
  CibypSandboxPolicyService,
  CibypApprovalService,
  ...require('./agents'),
  ...require('./llm'),
};
