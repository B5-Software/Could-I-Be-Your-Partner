/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const crypto = require('node:crypto');
const OSC_PATTERN = /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\|$)/g;
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const IGNORED = '(?: |\\x1b\\[[0-?]*[ -/]*[@-~])*';

function wrappedLiteral(text) {
  return [...text]
    .map((character) => {
      const literal = character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // ConPTY redraws the last column before emitting the next wrapped row.
      return literal + IGNORED + '(?:\\r?\\n\\x1b\\[\\d+;\\d+H' + literal + IGNORED + ')?';
    })
    .join('');
}

function wrappedCompletion(marker) {
  return new RegExp(
    wrappedLiteral(marker + ':') +
      '((?:' +
      wrappedLiteral('-') +
      ')?(?:(\\d)' +
      IGNORED +
      '(?:\\r?\\n\\x1b\\[\\d+;\\d+H\\2' +
      IGNORED +
      ')?)+)' +
      wrappedLiteral(':' + marker + '_END'),
  );
}

class TerminalCommand {
  constructor(term, shellName) {
    this.term = term;
    this.shellName = shellName;
    this.current = null;
  }

  start(command) {
    if (this.current?.running)
      return { ok: false, error: 'A command is still running; poll it or interrupt it first' };
    if (typeof command !== 'string' || !command.trim())
      return { ok: false, error: 'command is required' };
    const marker = 'CIBYP_DONE_' + crypto.randomBytes(16).toString('hex');
    this.current = {
      marker,
      output: '',
      running: true,
      offset: 0,
      waiters: new Set(),
      wrappedPattern: wrappedCompletion(marker),
    };
    // Keep execution in the same shell (cd/export survive). The marker is emitted
    // after execution and cannot be confused with echoed input or shell prompts.
    let framed;
    if (/powershell|pwsh/i.test(this.shellName))
      framed =
        command +
        "\r$cibypExit=if($?){0}elseif($LASTEXITCODE){$LASTEXITCODE}else{1}; [Console]::WriteLine(('" +
        marker +
        "'+':'+$cibypExit+':" +
        marker +
        "_END'))\r";
    else if (/(?:^|[/\\])cmd(?:\.exe)?$/i.test(this.shellName))
      framed = command + '\r@echo ' + marker + ':%errorlevel%:' + marker + '_END\r';
    else if (/fish/i.test(this.shellName))
      framed =
        command + "\nprintf '\\n%s:%s:%s\\n' '" + marker + "' $status '" + marker + "_END'\r";
    else
      framed =
        command.replace(/\r?\n/g, '\n') +
        "\nprintf '\\n%s:%s:%s\\n' '" +
        marker +
        '\' "$?" \'' +
        marker +
        "_END'\r";
    try {
      this.term.write(framed);
    } catch (error) {
      this.end(error.message);
    }
    return null;
  }

  append(data) {
    const current = this.current;
    if (!current?.running) return;
    current.output += data;
    // Bound retained output, keeping the tail and completion marker intact.
    if (current.output.length > 200000) {
      const removed = current.output.length - 100000;
      current.output = current.output.slice(removed);
      current.offset = Math.max(0, current.offset - removed);
      current.truncated = true;
    }
    // Mask title updates without shifting raw offsets. CMD titles can contain
    // the expanded echo command before the actual marker has been printed.
    const content = current.output.replace(OSC_PATTERN, (sequence) => ' '.repeat(sequence.length));
    const plain = content.replace(CSI_PATTERN, '');
    // ConPTY can use cursor escapes instead of newlines. A complete random end
    // marker also prevents a split multi-digit exit code from finishing early.
    const pattern = current.marker + ':(-?\\d+):' + current.marker + '_END';
    let match = new RegExp(pattern).exec(plain);
    let rawMatch = new RegExp(pattern).exec(content);
    if (!match) {
      rawMatch = current.wrappedPattern.exec(content);
      match = rawMatch;
    }
    if (match) {
      current.output = rawMatch
        ? current.output.slice(0, rawMatch.index)
        : plain.slice(0, match.index);
      current.output = current.output.replace(/[\r\n]+$/, '');
      // The usual raw marker keeps unread offsets stable across polls.
      current.offset = Math.min(current.offset, current.output.length);
      current.exitCode = Number(
        match[1]
          .replace(CSI_PATTERN, '')
          .replace(/(.)\r?\n\1/g, '$1')
          .replace(/[\r\n ]/g, ''),
      );
      current.running = false;
      for (const finish of [...current.waiters]) finish();
    }
  }

  end(error = 'Terminal exited') {
    if (!this.current?.running) return;
    this.current.error = error;
    this.current.running = false;
    for (const finish of [...this.current.waiters]) finish();
  }

  async wait(timeoutMs = 10000) {
    const current = this.current;
    if (!current) return { ok: false, error: 'No command to poll' };
    if (current.running)
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          current.waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(1, Math.min(60000, Number(timeoutMs) || 10000)));
        current.waiters.add(finish);
      });
    const output = current.output
      .slice(current.offset)
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '');
    current.offset = current.output.length;
    return {
      ok: !current.error && (current.running || current.exitCode === 0),
      output,
      running: current.running,
      timedOut: current.running,
      exitCode: current.exitCode,
      error: current.error,
      truncated: current.truncated === true,
    };
  }
}

module.exports = { TerminalCommand };
