/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const labels = require('./super-agent-labels.json');
const errors = {
  SUPER_INTERRUPTED: ['执行曾被中断。请检查已有结果，再继续恢复。','Execution was interrupted. Reconcile existing results before continuing.','Ausführung unterbrochen. Vor dem Fortsetzen vorhandene Ergebnisse prüfen.'],
  SUPER_ROUTING_FAILED: ['任务协调失败，可重新路由。','Routing failed. Retry this event.','Zuordnung fehlgeschlagen. Ereignis erneut zuordnen.'],
  SUPER_REPORT_REQUIRED: ['执行轮次已结束，尚未提交有效报告。','The turn ended without a valid report.','Die Runde endete ohne gültigen Bericht.'],
  SUPER_EXECUTION_FAILED: ['执行失败，请查看任务记录。','Execution failed. Inspect the task history.','Ausführung fehlgeschlagen. Aufgabenverlauf prüfen.'],
  SUPER_BLOCKED: ['任务需要补充信息。','Additional input is needed.','Zusätzliche Angaben werden benötigt.'],
  SUPER_USER_STOPPED: ['已按你的要求停止。','Stopped at your request.','Auf deinen Wunsch gestoppt.'],
  SUPER_PAUSED: ['后台任务已暂停。','Background tasks are paused.','Hintergrundaufgaben sind pausiert.'],
  SUPER_RESUMED: ['已保留历史，排队继续。','Queued to continue with existing history.','Mit bestehendem Verlauf zum Fortsetzen eingereiht.'],
  SUPER_WATCHDOG_PAUSED: ['进展检查已暂停任务，请核对原因。','Progress review paused the task. Inspect the diagnosis.','Fortschrittsprüfung hat die Aufgabe pausiert. Diagnose prüfen.'],
  SUPER_REPEATED_ACTION: ['检测到连续重复操作，已暂停。','Repeated identical actions detected; paused.','Wiederholte identische Aktionen erkannt; pausiert.'],
  SUPER_BUDGET_REACHED: ['已达到 token 或执行轮次上限。','The token or turn limit was reached.','Token- oder Rundenlimit erreicht.'],
  SUPER_DISABLED: ['SuperAgent 已关闭。','SuperAgent is disabled.','SuperAgent ist deaktiviert.'],
  SUPER_MODEL_UNAVAILABLE: ['所选模型不可用，请重新选择。','The selected model is unavailable. Choose another model.','Das ausgewählte Modell ist nicht verfügbar. Anderes Modell wählen.'],
  SUPER_TASK_CHANGED: ['任务状态已改变，请刷新。','The task changed. Refresh before retrying.','Die Aufgabe wurde geändert. Vor dem Wiederholen aktualisieren.'],
  SUPER_TASK_BUSY: ['请先停止当前任务。','Stop the current task first.','Zuerst die aktuelle Aufgabe stoppen.'],
  SUPER_TASK_STOPPED: ['任务已停止，请手动恢复。','The task is stopped. Resume it explicitly.','Die Aufgabe ist gestoppt. Ausdrücklich fortsetzen.'],
  SUPER_TASK_NOT_FOUND: ['找不到对应任务或事件。','Task or event not found.','Aufgabe oder Ereignis nicht gefunden.'],
  SUPER_INTERACTION_CHANGED: ['确认请求已处理或已过期，请刷新。','This confirmation was resolved or expired. Refresh.','Bestätigung erledigt oder abgelaufen. Aktualisieren.'],
  SUPER_HISTORY_UNAVAILABLE: ['无法恢复任务历史，已暂停以避免重复操作。','History could not be restored. Paused to prevent duplicate actions.','Verlauf nicht verfügbar. Zur Vermeidung doppelter Aktionen pausiert.'],
  SUPER_STORAGE_LOCKED: ['另一个后台正在使用任务数据。','Another backend owns the task data.','Ein anderer Hintergrunddienst verwendet die Aufgabendaten.'],
  SUPER_STORAGE_INVALID: ['任务数据校验失败，请保留数据并检查备份。','Task data validation failed. Preserve data and inspect backups.','Aufgabendatenprüfung fehlgeschlagen. Daten aufbewahren und Sicherungen prüfen.'],
  SUPER_STORAGE_LIMIT: ['任务存储已达到当前容量上限。','Task storage reached its current capacity limit.','Aufgabenspeicher hat die Kapazitätsgrenze erreicht.'],
  SUPER_STORAGE_UNAVAILABLE: ['任务存储不可用，已停止调度。','Task storage unavailable; scheduling stopped.','Aufgabenspeicher nicht verfügbar; Planung gestoppt.'],
  SUPER_INVALID_INPUT: ['请检查输入内容和允许范围。','Check the input and allowed ranges.','Eingaben und erlaubte Werte prüfen.'],
  SUPER_OPERATION_CONFLICT: ['操作标识已用于其他内容，请刷新重试。','Operation ID belongs to different content. Refresh and retry.','Vorgangs-ID gehört zu anderen Inhalten. Aktualisieren und erneut versuchen.'],
  SUPER_SCOPE_FORBIDDEN: ['信息不属于当前任务范围。','Information is outside this task scope.','Information liegt außerhalb dieses Aufgabenbereichs.'],
  SUPER_EVIDENCE_REQUIRED: ['完成报告需要具体的交付和验证依据。','Completion requires deliverables and verification evidence.','Abschluss benötigt Ergebnisse und Prüfnachweise.'],
  QUANT_DISABLED: ['量化功能暂未开放。','Quant features are not enabled.','Quant-Funktionen sind nicht aktiviert.'],
};
function superText(language, key) {
  const l = language?.startsWith('en') ? 'en' : language?.startsWith('de') ? 'de' : 'zh';
  return errors[key]?.[['zh','en','de'].indexOf(l)] || labels[l][key] || key;
}
module.exports = { superText };
