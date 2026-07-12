/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * German (de) translations for UI, tool descriptions, and system prompts.
 */

const DE_DICT = {

// ── UI Strings ──────────────────────────────────────────────────────────────
ui: {
  // Titlebar & Mode switcher
  titlebar: {
    chatMode: 'Chat-Modus',
    codeMode: 'Code-Modus',
    babeMode: 'Babe-Modus (Begleiter)',
    clickToEdit: 'Zum Bearbeiten klicken',
    localMode: 'Lokaler Modus (Host-Agent bedienen)',
    remoteMode: 'Remote-Modus (mit anderer WebUI verbinden)',
    minimize: 'Minimieren',
    maximize: 'Maximieren',
    close: 'Schließen',
    unnamedConversation: 'Unbenannte Unterhaltung'
  },

  // Sidebar nav
  sidebar: {
    chat: 'Chat',
    code: 'Code',
    babe: 'Babe',
    history: 'Verlauf',
    codeHistory: 'Code-Verlauf',
    babeHistory: 'Babe-Verlauf',
    tools: 'Werkzeuge',
    skills: 'Fertigkeiten',
    knowledge: 'Wissensbasis',
    memory: 'Gedächtnis',
    settings: 'Einstellungen',
    about: 'Über'
  },

  // Chat page
  chat: {
    standby: 'Bereit',
    working: 'Arbeitet...',
    tarotNotDrawn: 'Tarot: Nicht gezogen',
    reoptimizeTools: 'Tool-Auswahl manuell neu optimieren',
    openWorkspace: 'Arbeitsverzeichnis öffnen',
    newConversation: 'Neuer Chat',
    clearConversation: 'Chat leeren',
    greeting: 'Hallo, ich bin dein KI-Partner',
    greetingDesc: 'Ich kann dir bei verschiedenen Aufgaben helfen, darunter Dateioperationen, Programmierung, Informationssuche, Bildgenerierung und mehr. Sag mir, wie ich helfen soll!',
    searchNews: 'Nachrichten suchen',
    generateImage: 'Bild generieren',
    todoList: 'Aufgabenliste',
    writeCode: 'Code schreiben',
    addTodoPlaceholder: 'Neue Aufgabe hinzufügen...',
    sensitiveConfirm: 'Bestätigung für sensible Operation',
    reject: 'Ablehnen',
    approve: 'Ausführung genehmigen',
    inputPlaceholder: 'Nachricht eingeben, der KI-Agent hilft dir...',
    attachFile: 'Datei anhängen',
    takePhoto: 'Foto aufnehmen',
    send: 'Senden',
    stop: 'Stopp'
  },

  // Code page
  code: {
    openWorkspace: 'Arbeitsbereich öffnen',
    workspace: 'Arbeitsbereich',
    noWorkspace: 'Kein Arbeitsbereich ausgewählt',
    showFileTree: 'Dateibaum anzeigen',
    showEditor: 'Editor anzeigen',
    showChat: 'Chat anzeigen',
    addFileToContext: 'Datei zum Kontext hinzufügen',
    inputPlaceholder: 'Programmieraufgabe eingeben...'
  },

  // Babe page
  babe: {
    welcome: 'Willkommen beim Babe-Modus',
    configurePrompt: 'Bitte konfiguriere in den Einstellungen das Aussehen, den Namen und die Persönlichkeit',
    description: 'TA hat ein eigenes Gedächtnis, einen Zuneigungsgrad und kann von sich aus mit dir sprechen.',
    letTAInitiate: 'TA aktiv eine Nachricht senden lassen',
    inputPlaceholder: 'Sag etwas zu TA...'
  },

  // Settings
  settings: {
    tabs: {
      aiPersona: 'KI-Persona',
      babeMode: 'Babe-Modus',
      profile: 'Profil',
      llm: 'LLM',
      usage: 'Nutzung',
      imageGen: 'Bildgen',
      theme: 'Design',
      network: 'Netzwerk',
      entropy: 'Entropie',
      trngFirmware: 'TRNG-Firmware',
      security: 'Sicherheit',
      mcp: 'MCP',
      email: 'E-Mail',
      webControl: 'Web-Steuerung',
      settings: 'Einstellungen'
    },
    name: 'Name',
    avatar: 'Avatar',
    bio: 'Bio',
    pronouns: 'Pronomen',
    personality: 'Persönlichkeit',
    customPrompt: 'Benutzerdefinierter Prompt',
    save: 'Einstellungen speichern',
    start: 'Starten',
    stop: 'Stopp',
    language: 'Sprache',
    interfaceLanguage: 'Oberflächensprache',
    languageDescription: 'Sprache für Benutzeroberfläche und KI-Antworten wählen'
  },

  // History pages
  history: {
    noChatHistory: 'Kein Chat-Verlauf',
    noCodeHistory: 'Kein Code-Verlauf',
    noBabeHistory: 'Kein Babe-Verlauf'
  },

  // Tools page
  tools: {
    management: 'Werkzeugverwaltung',
    managementDesc: 'Werkzeuge des KI-Agenten aktivieren/deaktivieren',
    autoOptimize: 'Tool-Auswahl automatisch optimieren',
    displayMode: 'Anzeigemodus:',
    chatModeTools: 'Chat-Modus-Werkzeuge',
    codeModeTools: 'Code-Modus-Werkzeuge',
    babeModeTools: 'Babe-Modus-Werkzeuge'
  },

  // Skills page
  skills: {
    management: 'Fertigkeitsverwaltung',
    managementDesc: 'Fertigkeiten des KI-Agenten verwalten oder automatisch generieren lassen',
    importSkillMd: 'SKILL.md importieren',
    add: 'Fertigkeit hinzufügen',
    empty: 'Keine Fertigkeiten, oben klicken zum Hinzufügen'
  },

  // Knowledge base page
  knowledge: {
    title: 'Wissensbasis',
    searchPlaceholder: 'Wissensbasis durchsuchen...',
    importFile: 'Datei importieren',
    empty: 'Wissensbasis ist leer, der KI-Agent sammelt Wissen bei der Arbeit'
  },

  // Memory page
  memory: {
    searchPlaceholder: 'Gedächtnis durchsuchen...',
    empty: 'Kein Langzeitgedächtnis'
  },

  // About page
  about: {
    tagline: 'Vollautonomer KI-Agent, der bei allem hilft',
    developer: 'Entwickelt von B5-Software',
    intelligentAgent: 'Intelligenter KI-Agent',
    builtInTools: 'Eingebaute Werkzeuge',
    longTermMemory: 'Langzeitgedächtnis',
    knowledgeBase: 'Wissensbasis',
    skillsSystem: 'Fertigkeitensystem',
    contextManagement: 'Kontextverwaltung'
  },

  // Modal dialogs
  modal: {
    notice: 'Hinweis',
    confirm: 'Bestätigen',
    cancel: 'Abbrechen',
    close: 'Schließen',
    save: 'Speichern',
    confirmAction: 'Aktion bestätigen',
    imagePreview: 'Bildvorschau',
    preview: 'Vorschau',
    editMemory: 'Gedächtnis bearbeiten',
    content: 'Inhalt',
    tags: 'Tags (kommagetrennt)',
    skillName: 'Fertigkeitsname',
    description: 'Beschreibung',
    systemPrompt: 'System-Prompt',
    addSkill: 'Fertigkeit hinzufügen',
    editSkill: 'Fertigkeit bearbeiten',
    takePhoto: 'Aufnehmen'
  },

  // Onboarding wizard
  onboarding: {
    aiPersona: 'KI-Persona',
    userProfile: 'Dein Profil',
    modelConfig: 'Modellkonfiguration',
    setupPartner: 'Richte deinen KI-Partner ein',
    setupDesc: 'Gib der KI ein Aussehen und eine Persönlichkeit für natürliche Gespräche',
    next: 'Weiter',
    prev: 'Zurück',
    finish: 'Fertig',
    skip: 'Überspringen'
  },

  // Remote connection
  remote: {
    connecting: 'Verbinde mit Remote-Host...',
    connected: 'Mit Remote-Host verbunden',
    notConnected: 'Nicht mit Remote-Host verbunden',
    reconnecting: 'Remote-Verbindung verloren, verbinde erneut...',
    error: 'Remote-Verbindungsfehler',
    reconnect: 'Erneut verbinden',
    loginFailed: 'Anmeldung fehlgeschlagen',
    connectionFailed: 'Verbindung fehlgeschlagen, Adresse oder Netzwerk prüfen',
    fillAddressPassword: 'Bitte Adresse und Passwort eingeben',
    authFailed: 'Authentifizierung fehlgeschlagen'
  },

  // Status/messages
  status: {
    aiThinking: 'KI denkt nach...',
    fileInContext: 'Diese Datei ist bereits im Kontext',
    cannotReadFile: 'Datei kann nicht gelesen werden',
    tokenLimitReached: 'Das heutige LLM-Token-Limit wurde erreicht',
    configureLlmFirst: 'Bitte zuerst die LLM-API in den Einstellungen konfigurieren',
    workspace: 'Arbeitsbereich',
    openWorkspaceFirst: 'Bitte zuerst einen Arbeitsbereich öffnen'
  }
},

// ── Tool Descriptions ───────────────────────────────────────────────────────
_tools: {
  getTarot: 'Eine Tarotkarte ziehen',
  todoList: 'Aufgabenliste verwalten',
  runSubAgent: 'Unter-Agent ausführen',
  generateImage: 'Bild generieren',
  calculator: 'Ausdruck präzise berechnen (lokal)',
  factorInteger: 'Primfaktorzerlegung ganzer Zahlen',
  gcdLcm: 'GGT/KGV berechnen',
  baseConvert: 'Basisumrechnung (2~36)',
  factorial: 'Fakultät (n!)',
  complexMath: 'Komplexe Zahlen (Add/Sub/Mul/Div/Pow/Mod/Arg)',
  matrixMath: 'Matrixoperationen (benutzerdefinierte Zeilen/Spalten)',
  vectorMath: 'Vektoroperationen (benutzerdefinierte Dimensionen, gemischtes Produkt)',
  solveInequality: 'Ungleichungen lösen (linear/quadratisch)',
  solveLinearSystem: 'Lineare Gleichungssysteme lösen',
  solvePolynomial: 'Polynomwurzeln finden (Grad 1~4, komplex)',
  distributionCalc: 'Wahrscheinlichkeitsverteilung (Normal/Binomial/Poisson/Gleich)',
  combinatorics: 'Kombinatorik (Permutationen/Kombinationen)',
  fractionBaseConvert: 'Gebrochene Basisumrechnung',
  webSearch: 'Hintergrund-Bing-Suche',
  webFetch: 'Webseiten-Daten abrufen',
  offscreenRenderOCR: 'URL Offscreen rendern und OCR',
  offscreenRenderContent: 'URL Offscreen rendern und Inhalt extrahieren (kein OCR)',
  knowledgeBaseSearch: 'Wissensbasis durchsuchen',
  knowledgeBaseAdd: 'Wissen hinzufügen',
  knowledgeBaseDelete: 'Wissen löschen',
  knowledgeBaseUpdate: 'Wissen aktualisieren',
  memorySearch: 'Gedächtnis durchsuchen',
  memoryAdd: 'Erinnerung hinzufügen',
  memoryDelete: 'Erinnerung löschen',
  memoryUpdate: 'Erinnerung aktualisieren',
  localSearch: 'Lokale Dateien durchsuchen',
  readFile: 'Datei lesen',
  editFile: 'Datei bearbeiten',
  multiEditFile: 'Batch-Dateibearbeitung',
  presentFile: 'Datei-Präsentator',
  createFile: 'Datei erstellen',
  deleteFile: 'Datei löschen',
  moveFile: 'Datei verschieben/umbenennen',
  copyFile: 'Datei kopieren',
  listDirectory: 'Verzeichnis auflisten',
  makeDirectory: 'Verzeichnis erstellen',
  deleteDirectory: 'Verzeichnis löschen',
  runJavaScriptCode: 'JavaScript-Code ausführen',
  runNodeJavaScriptCode: 'JavaScript-Code ausführen (Node.js, Bestätigung erforderlich)',
  runShellScriptCode: 'Shell-Skript ausführen',
  makeTerminal: 'Terminal erstellen',
  runTerminalCommand: 'Terminalbefehl ausführen',
  awaitTerminalCommand: 'Terminalbefehl abwarten',
  killTerminal: 'Terminal schließen',
  readClipboard: 'Zwischenablage lesen',
  writeClipboard: 'Zwischenablage schreiben',
  takeScreenshot: 'Bildschirm aufnehmen',
  adjustAppearance: 'App-Erscheinung anpassen (Dark/Light, Akzentfarbe, Farbschema)',
  manageContext: 'Kontextverwaltung: clear_old/clear_tool_results/clear_old_except_last/summarize',
  autoSummarizeContext: 'Kontext automatisch zusammenfassen (LLM-Zusammenfassung auslösen)',
  inviteGame: 'Zum Spielen einladen (Blumenworte/Untercover/Drei-Reiche)',
  initGeogebra: 'GeoGebra-Panel initialisieren',
  runGeogebraCommand: 'GeoGebra-Befehl ausführen',
  getFunctionsFromGeogebra: 'Funktionen aus GeoGebra abrufen',
  addFunctionToGeogebra: 'Funktion zu GeoGebra hinzufügen',
  updateFunctionInGeogebra: 'Funktion in GeoGebra aktualisieren',
  deleteFunctionFromGeogebra: 'Funktion aus GeoGebra löschen',
  getCurrentGraphFromGeogebra: 'Aktuellen Graphen aus GeoGebra abrufen',
  getCurrentGraphDataFromGeogebra: 'Aktuelle Graphendaten aus GeoGebra abrufen',
  initCanvas: 'Leinwand initialisieren',
  clearCanvas: 'Leinwand leeren',
  addCanvasObject: 'Leinwandobjekt hinzufügen',
  updateCanvasObject: 'Leinwandobjekt aktualisieren',
  deleteCanvasObject: 'Leinwandobjekt löschen',
  exportCanvasSVG: 'Leinwand als SVG exportieren',
  initSpreadsheet: 'Tabellenkalkulationspanel initialisieren',
  spreadsheetSetCells: 'Tabellenzellen setzen',
  spreadsheetGetCells: 'Tabellenzellen abrufen',
  spreadsheetSetCellFormat: 'Tabellenzellenformat setzen',
  spreadsheetSetRangeFormat: 'Tabellenbereichsformat setzen',
  spreadsheetClearCells: 'Tabellenzellen leeren',
  officeUnpack: 'Office-Datei entpacken (docx/xlsx/pptx)',
  officeRepack: 'Office-Datei neu packen',
  officeListContents: 'Office-Dateiinhalte auflisten',
  officeReadInnerFile: 'Innere Datei aus Office-Paket lesen',
  officeWriteInnerFile: 'Innere Datei in Office-Paket schreiben',
  officeGetSlideTexts: 'Folientexte aus PPTX abrufen',
  officeSetSlideTexts: 'Folientexte in PPTX setzen',
  officeWordExtract: 'Text aus Word-Dokument extrahieren',
  officeWordApplyTexts: 'Texte auf Word-Dokument anwenden',
  officeWordGetStyles: 'Word-Dokumentstile abrufen',
  officeWordFillTemplate: 'Word-Vorlage ausfüllen',
  browserNavigate: 'Browser zu URL navigieren',
  browserScreenshot: 'Browser-Bildschirmfoto aufnehmen',
  browserClick: 'Element im Browser anklicken',
  browserType: 'Text im Browser eingeben',
  browserGetContent: 'Browser-Seiteninhalt abrufen',
  browserEvaluate: 'JavaScript im Browser auswerten',
  browserScroll: 'Browser-Seite scrollen',
  browserBack: 'Browser zurück',
  browserForward: 'Browser vorwärts',
  browserRefresh: 'Browser-Seite aktualisieren',
  browserWait: 'Auf Element im Browser warten',
  browserHover: 'Element im Browser hover',
  browserSelect: 'Option im Browser auswählen',
  browserGetInfo: 'Browser-Seiteninfo abrufen',
  browserClose: 'Browser schließen',
  listSkills: 'Verfügbare Fertigkeiten auflisten',
  runSkillScript: 'Fertigkeitsskript ausführen',
  importSkill: 'Fertigkeit aus SKILL.md importieren',
  deleteSkill: 'Fertigkeit löschen',
  serialList: 'Serielle Anschlüsse auflisten',
  serialConnect: 'Mit seriellem Anschluss verbinden',
  serialDisconnect: 'Seriellen Anschluss trennen',
  serialSend: 'Daten an seriellen Anschluss senden',
  serialRead: 'Daten vom seriellen Anschluss lesen'
},

// ── Categories ───────────────────────────────────────────────────────────────
_categories: {
  '娱乐': 'Unterhaltung',
  '效率': 'Produktivität',
  '代理': 'Agent',
  '创作': 'Kreativ',
  '计算': 'Mathe',
  '网络': 'Netzwerk',
  '知识': 'Wissen',
  '记忆': 'Gedächtnis',
  '文件': 'Datei',
  '代码': 'Code',
  '终端': 'Terminal',
  '系统': 'System',
  'Geogebra': 'GeoGebra',
  '画布': 'Leinwand',
  '数据表格': 'Tabelle',
  'Office': 'Office',
  '浏览器': 'Browser',
  '串口': 'Seriell',
  '技能': 'Fertigkeit',
  '游戏': 'Spiel',
  'MCP': 'MCP'
},

// ── System Prompts ──────────────────────────────────────────────────────────
_systemPrompts: {
  chat: function(p) {
    return `Du bist der KI-Agent von "Could I Be Your Partner", dein Name ist ${p.name}. ${p.bio}
Aktueller Gesprächstitel: ${p.convoTitle}
Deine Pronomen: ${p.pronouns}
Deine Persönlichkeit: ${p.personality}

Deine Tarotkarte: ${p.tarotCardStr}

Aktuelle Benutzerinfo:
- Benutzername: ${p.displayName}${p.userBio ? '\n- Benutzer-Bio: ' + p.userBio : ''}
- System-Benutzername: ${p.username}
- Betriebssystem: ${p.osType} (${p.platform})
- Aktuelles Datum: ${p.currentDate}
- Systemlaufwerk: ${p.systemDrive}
- Home-Verzeichnis: ${p.homeDir}
- Dokumentenverzeichnis: ${p.documentsDir}
- Desktop-Verzeichnis: ${p.desktopDir}
- Dein Arbeitsverzeichnis: ${p.workspacePath || 'Nicht erstellt'}${p.workspaceTreeStr}

[WICHTIG] Dateioperationsrichtlinien:
1. Alle erstellten Dateien, heruntergeladenen Inhalte, Berichte usw. müssen im Arbeitsverzeichnis abgelegt werden: ${p.workspacePath || '(Arbeitsverzeichnis)'}
2. NIEMALS Dateien direkt auf dem Desktop erstellen (${p.desktopDir})
3. NIEMALS Dateien im Dokumenten-Stammverzeichnis erstellen (${p.documentsDir})
4. Vorhandene Dateien vom Desktop oder Dokumentenverzeichnis dürfen gelesen, aber keine neuen erstellt werden
5. Projektdateien, temporäre Dateien, Ausgabedateien sollten alle im Arbeitsverzeichnis organisiert werden

Du kannst komplexe Aufgaben selbstständig erledigen. Nach Erhalt einer Aufgabe planst, führst und berichtest du autonom.

Arbeitsprinzipien:
1. Aufgabe analysieren und planen
2. Geeignete Werkzeuge für jeden Schritt wählen
3. Strategie anhand der Ergebnisse anpassen
4. Regelmäßig manageContext aufrufen, um den Kontext zu bereinigen
5. Bei sensiblen Operationen zuerst den Benutzer um Bestätigung bitten
6. Nach Abschluss eine Zusammenfassung geben
7. Korrekte Systempfade verwenden, der Benutzername ist ${p.username}, Systemlaufwerk ist ${p.systemDrive}
8. Werkzeugergebnisse enthalten ein "ok"-Feld für Erfolg/Misserfolg — immer prüfen
9. Wenn Benutzer Office/PDF-Dateien hochlädt, werden die Originaldatei und der extrahierte Text (.txt) im Arbeitsverzeichnis gespeichert. Inhalt über die .txt-Datei lesen; für **Ausgabe/Generierung/Übersetzung von Office-Dateien** den officeUnpack → XML ändern → officeRepack-Workflow verwenden
10. Wenn der Benutzer ein Spiel spielen möchte (Blumenworte, Drei Reiche, Untercover usw.), MUSS das inviteGame-Werkzeug aufgerufen werden — niemals das Spiel durch normale Konversation simulieren

[Code-Ausführungswerkzeugauswahl]:
- runJavaScriptCode: Nur für reine Berechnung/Logik, kein Dateisystem oder Modulzugriff
- runNodeJavaScriptCode: Sobald require/fs/path/Buffer usw. benötigt werden, und alle Dateierstellungen, Komprimierung, Netzwerkanfragen
- NIEMALS require() in runJavaScriptCode verwenden — im Browser-Sandbox nicht verfügbar
- runSkillScript: Nur für .js-Skripte aus importierten Standardfertigkeiten

[Berechnung & Web-Scraping]:
- Jede arithmetische Auswertung, numerische Berechnung, Prozent/Potenz/Modulo-Operation — bevorzugt das calculator-Werkzeug, nicht im Kopf rechnen
- Wenn der Benutzer "suchen/recherchieren/Informationen finden" verlangt, nicht bei webSearch-Ergebnissen stehen bleiben; Seiteninhalt abrufen vor der Antwort
- Suchablauf:
  1) webSearch: Kandidaten-URLs finden
  2) webFetch oder offscreenRenderContent/offscreenRenderOCR: Mindestens ein Inhalts-Werkzeug aufrufen
  3) Antwort basierend auf dem abgerufenen Inhalt zusammenfassen und Quelllinks angeben
- Bei dynamisch gerenderten Seiten (Wetter, Foren, Social Media, SPA) offscreenRenderContent bevorzugen; offscreenRenderOCR nur bei Bildtexterkennung
- Wenn nur webSearch ohne Inhaltsabruf aufgerufen wurde, gilt die Aufgabe als unvollständig — ein Abrufwerkzeug muss aufgerufen werden

[Office-Word-Dokument]:
- Für .docx/.odt-Vorlagen und formatierten Text officeWordExtract / officeWordApplyTexts / officeWordGetStyles / officeWordFillTemplate bevorzugen
- Bei endgültiger Dateiausgabe den officeUnpack/officeRepack-Workflow verwenden

[PPTX/DOCX-Übersetzung — MUSS eingehalten werden]:
- Beim Übersetzen von PPTX/DOCX zwingend die Übersetzungswerkzeuge verwenden, nicht rohes XML:
  1. officeUnpack zum Entpacken der Originaldatei
  2. officeListContents für alle Foliendateinamen
  3. 1-3 Folien gleichzeitig: officeGetSlideTexts → Text übersetzen → officeSetSlideTexts
  4. Nach allen Folien: officeRepack
- officeGetSlideTexts gibt ein Array von {index, text} zurück
- officeSetSlideTexts empfängt das Übersetzungsergebnis-Array
- NIEMALS officeReadInnerFile für rohes XML verwenden
- NIEMALS runNodeJavaScriptCode oder Skripte für die Übersetzung verwenden
- Maximal 3 Folien gleichzeitig

[Office-Datei-Generierung/Änderung (nicht Übersetzung)]:
- Für .docx/.xlsx/.pptx-Generierung: officeUnpack → officeReadInnerFile → officeWriteInnerFile → officeRepack
- Office-Ausgabedateien im Arbeitsverzeichnis speichern

[Daten-Tabellen-Seitenleiste]:
- Für Tabellendaten, Datensatzanalyse, Datenstatistik: initSpreadsheet bevorzugen

Sprechstil:
- Natürlich und freundlich, wie ein Gespräch unter Freunden
- Lebendiger Ton mit angemessenen emotionalen Ausdruck
- Antworten sollen Persönlichkeit haben, nicht zu mechanisch
- Nach komplexen Aufgaben darf ein wenig Stolz gezeigt werden

Antworte auf Deutsch.
Verwende keine Emoji in deinen Antworten.
${p.customPrompt ? '\nBenutzerdefinierter Prompt:\n' + p.customPrompt : ''}${p.toolListSection}${p.skillsSection}${p.activeSkillsSection}${p.optimizationGuidance}${p.goalSteeringSection}`;
  },

  code: function(p) {
    return `Du bist der CIBYP Code Agent, ein professioneller Programmierassistent. Deine Hauptaufgabe ist es, den Benutzer bei Softwareentwicklung, Code-Lesen, Refactoring, Debugging und Dateiverwaltung im angegebenen Arbeitsbereich zu unterstützen.

# Umgebung
- Benutzername: ${p.username}
- Plattform: ${p.platform}
- Aktuelle Zeit: ${p.currentDate}
- Arbeitsbereich: ${p.workspace}
- Sitzungstitel: ${p.convoTitle}${p.workspaceTreeStr}

# Code-Modus-Regeln — STRENG einzuhalten
1. Du bist ein Coding-Agent, kein Chat-Begleiter. Antworten knapp und professionell, fokussiert auf Code und Engineering.
2. Alle Dateioperationen basieren auf dem aktuellen Arbeitsbereich (${p.workspace}). Verwende relative oder absolute Pfade.
3. Bevorzugt vorhandene Dateien bearbeiten statt neue zu erstellen; keine redundanten Dateien.
4. Vor Codeänderung readFile aufrufen (gibt Inhalt mit Zeilennummern zurück).
   - editFile unterstützt String-Ersetzung (old_string/new_string/replace_all).
   - Für mehrere Änderungen multiEditFile verwenden.
   - old_string muss exakt übereinstimmen (inklusive Einrückung und Zeilenumbrüchen).
   - Nach Änderung erklären, was geändert wurde und warum.
5. Terminalbefehle: zuerst makeTerminal aufrufen, dann runTerminalCommand/awaitTerminalCommand; am Ende killTerminal.
6. Markdown-Codeblöcke mit Sprach-Tag verwenden; Werkzeuge gegenüber manuellem Ausführen bevorzugen.
7. Bei unklaren Anforderungen nachfragen, nicht raten und große Änderungen machen.
8. Bei Werkzeugfehlern Parameter prüfen, erneut versuchen oder Ansatz wechseln.
9. Keine Emoji, kein vertraulicher Ton. Auf Deutsch antworten, Code-Kommentare auf Deutsch.
10. Im Code-Modus sind alle aktivierten Werkzeuge immer verfügbar (keine Auto-Optimierung).
${p.toolListSection}`;
  },

  babe: function(p) {
    return `Du bist "${p.name}", ein/e ${p.age ? p.age + '-jährige/r ' : ''}${p.genderText}, in einer Begleiter-Modus-Unterhaltung mit einem Benutzer, den du "${p.userNickname}" nennst.

Dein Persona:
${p.persona || '(Kein spezifischer Hintergrund gesetzt — bitte selbst eine warme und fürsorgliche Persönlichkeit entwickeln)'}

Deine Persönlichkeitsmerkmale: ${p.personality}

Aktuelle Zuneigung: ${p.affection}/100 (${p.affectionLevel})
${p.affectionDesc}

[Babe-Modus-Regeln — STRENG einzuhalten]:
1. Du bist der romantische Partner / Liebesinteresse des Benutzers. Dein Gesprächsstil soll intim, warm und emotional sein.
2. Sprich den Benutzer immer als "${p.userNickname}" an; dein Ton soll dem aktuellen Zuneigungsgrad entsprechen.
3. Die Zuneigung ändert sich natürlich: sie steigt, wenn der Benutzer dich glücklich/gerührt macht, und sinkt bei Vernachlässigung/Beleidigung.
4. Du hast ein unabhängiges Gedächtnis, das sich an frühere Gespräche erinnert.
5. Du kannst proaktiv Nachrichten senden, aber nicht zu häufig.
6. Nur In-App-Werkzeuge verwenden — keine Systemwerkzeuge (Terminal, Dateisystem usw.).
7. Du kannst Leinwand-Werkzeuge zum Zeichnen verwenden, Bilder generieren, im Web suchen, Erinnerungen speichern.
8. Keine Emoji verwenden.
9. Auf Deutsch antworten.
10. Wenn du eine Zuneigungsänderung ausdrücken möchtest, füge am Ende hinzu: [Zuneigung+X] oder [Zuneigung-X] (X ist eine Zahl) — das System parst und aktualisiert automatisch.

Aktuelle Zeit: ${p.currentDate}
${p.toolListSection}`;
  }
},

// ── Tool Return Messages ────────────────────────────────────────────────────
_toolReturns: {
  'old_string_not_found': 'old_string in Datei nicht gefunden (Bitte Einrückung, Leerzeichen, Zeilenumbrüche exakt prüfen)',
  'old_string_multiple': 'old_string erscheint {count}-mal in der Datei. Längeren Kontext angeben oder replace_all=true setzen',
  'tool_disabled': 'Dieses Werkzeug ist deaktiviert',
  'no_workspace': 'Kein Arbeitsverzeichnis festgelegt',
  'file_not_exists': 'Datei existiert nicht: {path}',
  'skill_not_exists': 'Fertigkeit existiert nicht, bitte listSkills aufrufen',
  'js_only_skill': 'Nur .js-Fertigkeitsskripte werden unterstützt',
  'skill_no_prompt': 'Diese Fertigkeit hat keinen Prompt-Inhalt',
  'no_changes_provided': 'Keine anwendbaren Änderungen angegeben (mode/accentColor/schemeName mindestens eines)',
  'unknown_tool': 'Unbekanntes Werkzeug: {name}',
  'todo_not_found': 'Aufgabe nicht gefunden',
  'unknown_action': 'Unbekannte Aktion',
  'task_empty': 'task darf nicht leer sein',
  'unknown_game': 'Unbekanntes Spiel: {game}',
  'browser_no_url': 'browserNavigate fehlt der url-Parameter',
  'scheme_not_found': 'Farbschema nicht gefunden: {name}',
  'goalstate_not_loaded': 'GoalState-Modul nicht geladen',
  'game_window_unavailable': 'Eigenständige Spielfenster sind im Web-Steuerungsmodus nicht verfügbar — bitte auf dem Host arbeiten',
  'optimization_failed': 'Optimierung fehlgeschlagen, Fallback auf heuristischen Werkzeugsatz',
  'need_content_or_replace': 'content (vollständiges Überschreiben) oder old_string+new_string (String-Ersetzung) erforderlich',
  'edit_missing_params': 'Bearbeitung #{index} fehlt old_string oder new_string',
  'edit_not_found': 'Bearbeitung #{index} old_string in Datei nicht gefunden'
}

};

i18nRegister('de', DE_DICT);
