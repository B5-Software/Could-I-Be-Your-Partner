/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Goal state machine + steering prompts, ported from claude-code-ref.
 * Keeps the agent on-track for long-running, multi-turn objectives.
 */

'use strict';

// ---- Constants ----
const MAX_GOAL_TURNS = 150;
const BLOCKED_CONSECUTIVE_THRESHOLD = 3;

// ---- State ----
// Map<sessionId, GoalState> — sessionId defaults to 'main' for the primary conversation.
const _goals = new Map();

function _defaultSession() { return 'main'; }

function _newState(objective) {
  return {
    objective,
    status: 'active',
    turnsExecuted: 0,
    tokensUsed: 0,
    tokenBudget: 0,
    blockedAttempts: 0,
    lastBlockedReason: null,
    startedAt: Date.now(),
    pausedAt: null,
    accumulatedActiveMs: 0,
    maxTurnsReached: false,
    completionSummary: null
  };
}

function setGoal(sessionId, objective, tokenBudget = 0) {
  const sid = sessionId || _defaultSession();
  _goals.set(sid, _newState(objective));
  if (tokenBudget > 0) _goals.get(sid).tokenBudget = tokenBudget;
  return _goals.get(sid);
}

function getGoal(sessionId) {
  return _goals.get(sessionId || _defaultSession()) || null;
}

function pauseGoal(sessionId) {
  const g = getGoal(sessionId);
  if (!g) return null;
  if (g.status === 'active' && g.pausedAt == null) {
    g.pausedAt = Date.now();
  }
  g.status = 'paused';
  return g;
}

function resumeGoal(sessionId) {
  const g = getGoal(sessionId);
  if (!g) return null;
  if (g.pausedAt != null) {
    g.accumulatedActiveMs += Date.now() - g.pausedAt;
    g.pausedAt = null;
  }
  g.status = 'active';
  g.blockedAttempts = 0; // reset on resume
  return g;
}

function completeGoal(sessionId, summary) {
  const g = getGoal(sessionId);
  if (!g) return null;
  g.status = 'complete';
  g.completionSummary = summary || null;
  return g;
}

function clearGoal(sessionId) {
  _goals.delete(sessionId || _defaultSession());
}

function markGoalMaxTurnsReached(sessionId) {
  const g = getGoal(sessionId);
  if (!g) return null;
  g.maxTurnsReached = true;
  g.status = 'max_turns';
  return g;
}

function continueGoalFromMaxTurns(sessionId) {
  const g = getGoal(sessionId);
  if (!g) return null;
  g.maxTurnsReached = false;
  g.turnsExecuted = 0;
  g.status = 'active';
  return g;
}

function recordGoalTurn(sessionId) {
  const g = getGoal(sessionId);
  if (!g) return null;
  g.turnsExecuted++;
  if (g.turnsExecuted >= MAX_GOAL_TURNS && g.status === 'active') {
    markGoalMaxTurnsReached(sessionId);
  }
  return g;
}

function updateGoalTokens(sessionId, deltaTokens) {
  const g = getGoal(sessionId);
  if (!g) return null;
  g.tokensUsed += deltaTokens;
  if (g.tokenBudget > 0 && g.tokensUsed >= g.tokenBudget && g.status === 'active') {
    g.status = 'budget_limited';
  }
  return g;
}

function recordBlockedAttempt(sessionId, reason) {
  const g = getGoal(sessionId);
  if (!g) return null;
  if (reason && reason === g.lastBlockedReason) {
    g.blockedAttempts++;
    if (g.blockedAttempts >= BLOCKED_CONSECUTIVE_THRESHOLD && g.status === 'active') {
      g.status = 'blocked';
    }
  } else {
    g.blockedAttempts = 1;
    g.lastBlockedReason = reason || null;
  }
  return g;
}

function isGoalActive(sessionId) {
  const g = getGoal(sessionId);
  return g?.status === 'active';
}

// ---- Steering Prompts ----
// These XML-wrapped prompts are injected into the system context when the goal is active.

function continuationPrompt(g) {
  if (!g) return '';
  return `<goal-steering>
The agent is working toward this objective: ${g.objective}

Status: ${g.status}, turn ${g.turnsExecuted}/${MAX_GOAL_TURNS}, tokens ${g.tokensUsed}${g.tokenBudget ? '/' + g.tokenBudget : ''}

<completion-audit>
Before responding, audit whether the objective is FULLY achieved:
- List specific deliverables that prove completion (not "I couldn't find anything left to do").
- If any deliverable is missing or unverified, continue working.
- Do NOT narrow the scope of the objective to declare completion early.
</completion-audit>

<blocked-audit>
If you are stuck on the same obstacle for ${BLOCKED_CONSECUTIVE_THRESHOLD} consecutive turns with the SAME root cause, report it as blocked.
Difficulty, slowness, or partial incompleteness do NOT count as blocked.
Only report blocked when you have a concrete, repeated failure with the same cause.
</blocked-audit>
</goal-steering>`;
}

function budgetLimitPrompt(g) {
  if (!g) return '';
  return `<goal-steering>
Budget limit reached: ${g.tokensUsed} tokens used (budget ${g.tokenBudget}).

Stop making tool calls that consume significant tokens. Summarize:
1. What has been accomplished so far
2. What remains to be done
3. Recommended next steps for the user

Do not start new substantial work.
</goal-steering>`;
}

function objectiveUpdatedPrompt(oldObjective, newObjective) {
  return `<goal-steering>
The objective has been updated by the user.

Previous objective: ${oldObjective || '(none)'}
New objective: ${newObjective}

Re-plan your approach for the new objective. Do not assume prior work applies.
</goal-steering>`;
}

function getSteeringPrompt(sessionId) {
  const g = getGoal(sessionId);
  if (!g) return '';
  if (g.status === 'active') return continuationPrompt(g);
  if (g.status === 'budget_limited') return budgetLimitPrompt(g);
  if (g.status === 'max_turns') {
    return `<goal-steering>
Max turns (${MAX_GOAL_TURNS}) reached for this goal. The goal will auto-continue with reset turn count.
Objective: ${g.objective}
Review your progress and continue from where you left off.
</goal-steering>`;
  }
  if (g.status === 'blocked') {
    return `<goal-steering>
Goal is BLOCKED after ${g.blockedAttempts} consecutive failures with the same cause: ${g.lastBlockedReason || 'unknown'}

Report the blocker to the user and suggest workarounds. Do not retry the same approach.
</goal-steering>`;
  }
  return '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_GOAL_TURNS,
    BLOCKED_CONSECUTIVE_THRESHOLD,
    setGoal, getGoal, pauseGoal, resumeGoal, completeGoal, clearGoal,
    markGoalMaxTurnsReached, continueGoalFromMaxTurns,
    recordGoalTurn, updateGoalTokens, recordBlockedAttempt,
    isGoalActive, getSteeringPrompt,
    continuationPrompt, budgetLimitPrompt, objectiveUpdatedPrompt
  };
}

// Expose as global for browser/script-tag loading (no module system)
if (typeof window !== 'undefined') {
  window.GoalState = {
    MAX_GOAL_TURNS,
    BLOCKED_CONSECUTIVE_THRESHOLD,
    setGoal, getGoal, pauseGoal, resumeGoal, completeGoal, clearGoal,
    markGoalMaxTurnsReached, continueGoalFromMaxTurns,
    recordGoalTurn, updateGoalTokens, recordBlockedAttempt,
    isGoalActive, getSteeringPrompt,
    continuationPrompt, budgetLimitPrompt, objectiveUpdatedPrompt
  };
}
// Also expose as bare GoalState for agent.js typeof checks
if (typeof globalThis !== 'undefined') {
  globalThis.GoalState = (typeof window !== 'undefined' ? window.GoalState : null) || {
    MAX_GOAL_TURNS, BLOCKED_CONSECUTIVE_THRESHOLD,
    setGoal, getGoal, pauseGoal, resumeGoal, completeGoal, clearGoal,
    markGoalMaxTurnsReached, continueGoalFromMaxTurns,
    recordGoalTurn, updateGoalTokens, recordBlockedAttempt,
    isGoalActive, getSteeringPrompt,
    continuationPrompt, budgetLimitPrompt, objectiveUpdatedPrompt
  };
}
