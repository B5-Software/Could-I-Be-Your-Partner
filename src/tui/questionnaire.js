/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { LineEditor } = require('./editor');
const { t } = require('./text');

class Questionnaire {
  constructor(questions, sessionKey) {
    this.questions = questions;
    this.sessionKey = sessionKey;
    this.answers = questions.map(() => null);
    this.custom = questions.map(() => '');
    this.confirmedCustom = questions.map(() => '');
    this.checked = questions.map(() => new Set());
  }

  choices(index) {
    const options = this.questions[index].options;
    return (Array.isArray(options) ? options : []).flatMap((option) => {
      const label = typeof option === 'string' ? option : (option?.label ?? option?.value);
      if (label == null || !String(label).trim()) return [];
      return [
        {
          label: String(label),
          value: String(typeof option === 'string' ? option : (option.value ?? label)),
          description: option.description || '',
        },
      ];
    });
  }

  build(index = 0) {
    if (index >= this.questions.length) return this.review();
    const question = this.questions[index];
    const choices = this.choices(index);
    const multiple = question.multiSelect === true || question.multiple === true;
    const modal = {
      kind: 'ask',
      phase: 'question',
      questionnaire: this,
      sessionKey: this.sessionKey,
      colorKey: 'permission',
      questionIndex: index,
      title: t('ui.tui.askTitle', '回答提问（{index}/{total}）', {
        index: index + 1,
        total: this.questions.length,
      }),
      subtitle: String(
        question.question || question.title || question.label || t('ui.tui.askDefault', '请回答'),
      ),
      selected: 0,
      footer: multiple
        ? t(
            'ui.tui.askMultiNav',
            '↑↓ 选择 · Space/Enter 勾选 · Tab 下一题 · ←→ 切换题目 · Esc 取消',
          )
        : t('ui.tui.askNav', '↑↓ 选择 · Enter 确认 · ←→/Tab 切换题目 · Esc 取消'),
    };
    if (!choices.length) return this.input(modal);
    modal.options = choices.map((choice) => ({
      ...choice,
      value: { action: 'choice', answer: choice.value },
      label: `${multiple ? (this.checked[index].has(choice.value) ? '[x]' : '[ ]') : this.answers[index] === choice.value ? '●' : '○'} ${choice.label}`,
    }));
    if (question.custom !== false)
      modal.options.push({
        label:
          t('ui.tui.askCustom', '填写自己的回答') +
          (this.custom[index] ? ': ' + this.custom[index] : ''),
        value: { action: 'custom' },
      });
    if (multiple)
      modal.options.push({ label: t('ui.tui.askContinue', '完成本题'), value: { action: 'next' } });
    return modal;
  }

  input(modal) {
    const editor = new LineEditor();
    editor.setValue(this.custom[modal.questionIndex]);
    return {
      ...modal,
      options: undefined,
      inputMode: true,
      editor,
      footer: t('ui.tui.askInputNav', 'Enter 确认 · Shift+Enter 换行 · Esc 返回 · Alt+←→ 切换题目'),
    };
  }

  move(modal, step) {
    if (modal.inputMode) this.custom[modal.questionIndex] = modal.editor.value;
    if (modal.phase === 'review') return this.build(step < 0 ? this.questions.length - 1 : 0);
    if (modal.phase !== 'question') return modal;
    const index = modal.questionIndex + step;
    if (index < 0) return this.build(0);
    return index >= this.questions.length ? this.review() : this.build(index);
  }

  choose(modal, index) {
    const option = modal.options?.[index];
    if (!option) return modal;
    const value = option.value;
    if (value.action === 'edit') return this.build(value.index);
    if (value.action === 'resume') return this.build(value.index ?? 0);
    if (value.action === 'cancel') return this.cancel(modal);
    if (value.action === 'discard') return { submit: true, answers: [] };
    if (value.action === 'submit') {
      const missing = this.answers.findIndex(
        (answer) => answer == null || answer === '' || (Array.isArray(answer) && !answer.length),
      );
      if (missing >= 0)
        return { ...this.build(missing), error: t('ui.tui.askRequired', '请先回答这一题') };
      return {
        submit: true,
        answers: this.answers.map((answer) => (Array.isArray(answer) ? [...answer] : answer)),
      };
    }
    if (value.action === 'custom') return this.input(modal);
    const question = this.questions[modal.questionIndex];
    const multiple = question.multiSelect === true || question.multiple === true;
    if (value.action === 'choice') {
      if (!multiple) {
        this.answers[modal.questionIndex] = value.answer;
        return this.move(modal, 1);
      }
      const checked = this.checked[modal.questionIndex];
      if (checked.has(value.answer)) checked.delete(value.answer);
      else checked.add(value.answer);
      this.answers[modal.questionIndex] = [
        ...checked,
        ...(this.confirmedCustom[modal.questionIndex]
          ? [this.confirmedCustom[modal.questionIndex]]
          : []),
      ];
      return { ...this.build(modal.questionIndex), selected: index };
    }
    if (value.action === 'next') {
      if (!this.answers[modal.questionIndex]?.length)
        return { ...modal, error: t('ui.tui.askRequired', '请先回答这一题') };
      return this.move(modal, 1);
    }
    return modal;
  }

  answerInput(modal) {
    const answer = modal.editor.value.trim();
    this.custom[modal.questionIndex] = modal.editor.value;
    if (!answer) return { ...modal, error: t('ui.tui.askRequired', '请先回答这一题') };
    this.confirmedCustom[modal.questionIndex] = answer;
    const question = this.questions[modal.questionIndex];
    if (
      (question.multiSelect === true || question.multiple === true) &&
      this.choices(modal.questionIndex).length
    ) {
      this.answers[modal.questionIndex] = [
        ...new Set([...this.checked[modal.questionIndex], answer]),
      ];
      return this.build(modal.questionIndex);
    }
    this.answers[modal.questionIndex] = answer;
    return this.move(modal, 1);
  }

  escape(modal) {
    if (modal.phase === 'cancel') return modal.previous;
    if (modal.inputMode && this.choices(modal.questionIndex).length) {
      this.custom[modal.questionIndex] = modal.editor.value;
      return this.build(modal.questionIndex);
    }
    return this.cancel(modal);
  }

  cancel(previous) {
    return {
      kind: 'ask',
      phase: 'cancel',
      questionnaire: this,
      previous,
      sessionKey: this.sessionKey,
      title: t('ui.tui.askCancelTitle', '取消问卷？'),
      body: t(
        'ui.tui.askCancelBody',
        '取消后 Agent 会收到未回答状态。已填写内容不会被当作完整答案提交。',
      ),
      options: [
        {
          label: t('ui.tui.askResume', '继续填写'),
          value: { action: 'resume', index: previous.questionIndex },
        },
        { label: t('ui.tui.askDiscard', '取消并通知 Agent'), value: { action: 'discard' } },
      ],
      selected: 0,
    };
  }

  review() {
    return {
      kind: 'ask',
      phase: 'review',
      questionnaire: this,
      sessionKey: this.sessionKey,
      colorKey: 'permission',
      title: t('ui.tui.askReview', '检查并提交回答'),
      subtitle: t('ui.tui.askReviewHint', '选择题目可返回修改；提交后 Agent 才会继续。'),
      options: [
        ...this.questions.map((question, index) => ({
          label: `${index + 1}. ${question.question || question.title || question.label || ''}`,
          description: Array.isArray(this.answers[index])
            ? this.answers[index].join(', ')
            : this.answers[index] || t('ui.tui.askUnanswered', '尚未回答'),
          value: { action: 'edit', index },
        })),
        { label: t('ui.tui.askSubmit', '提交回答'), value: { action: 'submit' } },
        { label: t('ui.tui.cancel', '取消'), value: { action: 'cancel' } },
      ],
      selected: this.questions.length,
    };
  }
}
module.exports = { Questionnaire };
