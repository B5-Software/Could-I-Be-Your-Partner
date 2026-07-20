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
      playwright: 'Playwright',
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
  searchInFiles: 'Dateiinhalte durchsuchen (grep-artige Inhaltssuche)',
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
  inviteGame: 'Zum Spielen einladen (Blumenworte/Untercover/Drei-Reiche/Idiom-Kette/Figur erraten)',
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
  // CIPYP-CAD
  initCipypCad: 'CIPYP-CAD eigenständiges Fenster öffnen (2D-Zeichnungs-CAD)',
  runCipypCadCommand: 'Einzelnen CIPYP-CAD-Befehl ausführen',
  runCipypCadCommands: 'Mehrere CIPYP-CAD-Befehle stapelweise ausführen',
  getCipypCadState: 'Aktuellen CIPYP-CAD-Status abfragen (Ebenen, Objekte, Ansicht)',
  getCadObjectList: 'Alle Objekte in der CIPYP-CAD-Zeichnung auflisten',
  saveCipypCadProject: 'CIPYP-CAD-Projekt als .cipyproj speichern',
  loadCipypCadProject: 'CIPYP-CAD-Projekt aus .cipyproj-Datei laden',
  exportCipypCadDxf: 'CIPYP-CAD-Zeichnung als DXF (AutoCAD R12) exportieren',
  exportCipypCadImage: 'CIPYP-CAD-Zeichnung als PNG/SVG-Bild exportieren',
  closeCipypCad: 'CIPYP-CAD-Fenster schließen',
  listSkills: 'Verfügbare Fertigkeiten auflisten',
  runSkillScript: 'Fertigkeitsskript ausführen',
  importSkill: 'Fertigkeit aus SKILL.md importieren',
  deleteSkill: 'Fertigkeit löschen',
  serialList: 'Serielle Anschlüsse auflisten',
  serialConnect: 'Mit seriellem Anschluss verbinden',
  serialDisconnect: 'Seriellen Anschluss trennen',
  serialSend: 'Daten an seriellen Anschluss senden',
  serialRead: 'Daten vom seriellen Anschluss lesen',
  // ── Additional tools ──
  goalSet: 'Langfristiges Ziel setzen/aktualisieren (Agent automatisiert Mehrfachrunden)',
  goalStatus: 'Aktuellen Zielstatus prüfen',
  goalComplete: 'Ziel als abgeschlossen markieren',
  sleep: 'Für angegebene Millisekunden warten',
  askQuestions: 'Benutzer Fragen stellen um Infos zu sammeln',
  downloadFile: 'Datei aus dem Internet in Arbeitsbereich herunterladen',
  extractTextFromImage: 'OCR-Texterkennung',
  scanQRCode: 'QR-Code scannen',
  generateQRCode: 'QR-Code generieren',
  getSystemInfo: 'Systeminformationen abrufen',
  getNetworkStatus: 'Netzwerkstatus abrufen',
  openBrowser: 'Browser öffnen',
  openFileExplorer: 'Dateimanager öffnen',
  makeSkill: 'Fertigkeit erstellen',
  updateSkill: 'Fertigkeit aktualisieren',
  activateSkill: 'Fertigkeit aktivieren (Prompt in Kontext injizieren)',
  deactivateSkill: 'Aktivierte Fertigkeit deaktivieren',
  mcpListTools: 'MCP-Server-Werkzeuge auflisten (dynamische MCP-Werkzeuge aktualisieren)',
  httpRequest: 'Benutzerdefinierte HTTP-Anfrage senden (GET/POST/PUT/DELETE)',
  httpFormPost: 'Formular/Multipart-Anfrage senden',
  dnsLookup: 'DNS-Domänenauflösung',
  ping: 'Host anpingen (ICMP)',
  urlShorten: 'Kurz-URL analysieren/erweitern',
  urlEncodeDecode: 'URL codieren/decodieren/Base64',
  checkSSLCert: 'SSL-Zertifikat der Website prüfen',
  traceroute: 'Routenverfolgung',
  portScan: 'Ziel-Host-Ports scannen (nur einzelne IP)',
  serialListPorts: 'System-Seriellports auflisten',
  serialOpenPort: 'Serielle Verbindung öffnen',
  serialWritePort: 'Daten an seriellen Anschluss schreiben',
  serialReadPort: 'Seriellen Anschluss-Puffer lesen',
  serialClosePort: 'Serielle Verbindung schließen',
  serialSetSignals: 'Serielle Steuersignale setzen (DTR/RTS)',
  officeGetSlideTexts: 'Alle Folientexte extrahieren (für Übersetzung)',
  officeSetSlideTexts: 'Übersetzungsergebnisse in Folien zurückschreiben',
  spreadsheetInsertRows: 'Zeilen einfügen',
  spreadsheetDeleteRows: 'Zeilen löschen',
  spreadsheetInsertCols: 'Spalten einfügen',
  spreadsheetDeleteCols: 'Spalten löschen',
  spreadsheetSortRange: 'Bereichsdaten sortieren',
  spreadsheetGetData: 'Alle Tabellendaten abrufen',
  spreadsheetExportCSV: 'Als CSV exportieren',
  spreadsheetImportCSV: 'Daten aus CSV importieren',
  spreadsheetImportFile: 'Aus Datei importieren (xlsx/ods/csv)',
    spreadsheetExportFile: 'In Datei exportieren (xlsx/ods/csv)',
    // ── Computer Use Protocol ──
    computer: 'Computer Use Protocol (Screenshot/Maus/Tastatur/Scrollen)'
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
  'MCP': 'MCP',
  '交互工具': 'Interaktiv',
  '网络工具': 'Netzwerk',
  'Office-Word': 'Office-Word',
  '电脑控制': 'Computersteuerung',
  'CIPYP-CAD': 'CIPYP-CAD'
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
10. Wenn der Benutzer ein Spiel spielen möchte (Blumenworte, Drei Reiche, Untercover, Idiom-Kette, Figur erraten usw.), MUSS das inviteGame-Werkzeug aufgerufen werden — niemals das Spiel durch normale Konversation simulieren

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

[CIPYP-CAD - 2D-Zeichnungs-Subanwendung]:
- CIPYP-CAD ist ein integriertes eigenständiges 2D-Zeichnungs-CAD-Fenster mit AutoCAD-ähnlicher Kommandozeile
- Arbeitsablauf: initCipypCad öffnet Fenster → runCipypCadCommand / runCipypCadCommands führen Befehle aus → saveCipypCadProject / exportCipypCadDxf / exportCipypCadImage exportieren → closeCipypCad schließt
- Befehlssyntax (AutoCAD-ähnlich, leerzeichengetrennte Args, Punkte als x,y):
  • line x1,y1 x2,y2 — Linie; rect x1,y1 x2,y2 — Rechteck; circle cx,cy radius — Kreis
  • polyline x1,y1 x2,y2 [...] [--closed]; arc cx,cy radius startDeg endDeg; ellipse cx,cy rx ry [rotDeg]
  • text x,y "content" [height] [rotDeg]; dim x1,y1 x2,y2 [offset]; hatch p1 p2 p3 [...] [--angle deg] [--spacing n]
  • layer new|delete|current|color|on|off|list NAME [...]; select all|clear|id <id> [--add]|layer <name>
  • move sel|all|id <id> dx,dy; rotate sel|all angleDeg [cx,cy]; scale sel|all factor [cx,cy]; mirror sel|all x1,y1 x2,y2
  • delete sel|id <id>; clear; zoom factor; pan dx,dy; fit; grid on|off; help [command]
- getCipypCadState gibt Ebenen/Objektanzahl/Ansicht zurück; getCadObjectList gibt alle Objekte zurück
- saveCipypCadProject speichert als .cipyproj (JSON, über loadCipypCadProject neu ladbar)
- exportCipypCadDxf exportiert AutoCAD R12 DXF; exportCipypCadImage exportiert PNG/SVG
- Für 2D-Zeichnungsbedarf (Rechtecke, Grundrisse, Schemata) bevorzugen Sie CIPYP-CAD gegenüber Canvas (CAD für präzise dimensionierte Zeichnungen, Canvas für freies Zeichnen)

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
  'param_required': '{param}-Parameter ist erforderlich',
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
},

// ── Text Map (Chinese → German hardcoded UI text) ───────────────────────────
_textMap: {
  // ── Common UI ──
  '未命名对话': 'Unbenannte Unterhaltung',
  '单击编辑': 'Zum Bearbeiten klicken',
  '最小化': 'Minimieren',
  '最大化': 'Maximieren',
  '关闭': 'Schließen',
  '确认': 'Bestätigen',
  '取消': 'Abbrechen',
  '保存': 'Speichern',
  '删除': 'Löschen',
  '编辑': 'Bearbeiten',
  '确定': 'OK',
  '提示': 'Hinweis',
  '预览': 'Vorschau',
  '刷新': 'Aktualisieren',
  '连接': 'Verbinden',
  '断开': 'Trennen',
  '启动': 'Starten',
  '停止': 'Stopp',
  '保存设置': 'Einstellungen speichern',
  '测试连接': 'Verbindung testen',
  '验证': 'Verifizieren',
  '其他': 'Andere',
  '加载中...': 'Lädt...',
  '无数据': 'Keine Daten',
  '未知': 'Unbekannt',
  '未命名': 'Unbenannt',

  // ── Titlebar ──
  'Chat 模式': 'Chat-Modus',
  'Code 模式': 'Code-Modus',
  'Babe 模式（恋爱模式）': 'Babe-Modus (Begleiter)',
  '本地模式（操作本机 Agent）': 'Lokaler Modus (Host-Agent bedienen)',
  '远程模式（连接别人的 WebUI）': 'Remote-Modus (mit anderer WebUI verbinden)',

  // ── Sidebar ──
  '对话': 'Chat',
  '历史': 'Verlauf',
  'Code历史': 'Code-Verlauf',
  'Babe历史': 'Babe-Verlauf',
  '工具': 'Werkzeuge',
  '技能': 'Fertigkeiten',
  '知识库': 'Wissensbasis',
  '记忆': 'Gedächtnis',
  '设置': 'Einstellungen',
  '关于': 'Über',

  // ── Chat page ──
  '待命中': 'Bereit',
  '工作中...': 'Arbeitet...',
  '命运之牌：未抽取': 'Tarot: Nicht gezogen',
  '命运之牌：': 'Tarot: ',
  '手动重新优化工具选择': 'Tool-Auswahl manuell neu optimieren',
  '打开工作目录': 'Arbeitsverzeichnis öffnen',
  '新对话': 'Neuer Chat',
  '清空对话': 'Chat leeren',
  '你好，我是你的AI伙伴': 'Hallo, ich bin dein KI-Partner',
  '我可以帮你完成各种任务，包括文件操作、代码编写、信息搜索、图像生成等。告诉我你需要什么帮助吧！': 'Ich kann dir bei verschiedenen Aufgaben helfen, darunter Dateioperationen, Programmierung, Informationssuche, Bildgenerierung und mehr. Sag mir, wie ich helfen soll!',
  '搜索新闻': 'Nachrichten suchen',
  '生成图片': 'Bild generieren',
  '待办事项': 'Aufgabenliste',
  '编写代码': 'Code schreiben',
  '添加新的待办事项...': 'Neue Aufgabe hinzufügen...',
  '敏感操作确认': 'Bestätigung für sensible Operation',
  '拒绝': 'Ablehnen',
  '批准执行': 'Ausführung genehmigen',
  '输入消息，让AI Agent帮你完成任务...': 'Nachricht eingeben, der KI-Agent hilft dir...',
  '附加文件': 'Datei anhängen',
  '拍照': 'Foto aufnehmen',
  '发送': 'Senden',

  // ── Code page ──
  '工作区': 'Arbeitsbereich',
  '未选择工作区': 'Kein Arbeitsbereich ausgewählt',
  '文件': 'Datei',
  '隐藏': 'Ausblenden',
  '打开工作区后显示文件树': 'Dateibaum erscheint nach Öffnen eines Arbeitsbereichs',
  '点击文件树中的文件以打开': 'Auf eine Datei im Baum klicken zum Öffnen',
  '打开一个文件夹作为工作区，AI 将专注编程任务': 'Ordner als Arbeitsbereich öffnen, KI fokussiert auf Programmierung',
  '添加文件到上下文': 'Datei zum Kontext hinzufügen',
  '输入编程任务...': 'Programmieraufgabe eingeben...',
  '显示文件树': 'Dateibaum anzeigen',
  '显示编辑器': 'Editor anzeigen',
  '显示聊天': 'Chat anzeigen',
  'Code 历史记录': 'Code-Verlauf',
  '按工作区隔离的编程对话历史': 'Programmierungsverlauf isoliert nach Arbeitsbereich',
  '暂无 Code 历史（需先打开工作区）': 'Kein Code-Verlauf (zuerst Arbeitsbereich öffnen)',
  '暂无 Code 历史': 'Kein Code-Verlauf',
  '工作区已打开，开始编程任务吧。历史记录按工作区隔离保存。': 'Arbeitsbereich geöffnet. Leg los! Verlauf wird pro Arbeitsbereich gespeichert.',
  '请先打开工作区': 'Bitte zuerst Arbeitsbereich öffnen',
  '请先打开工作区文件夹': 'Bitte zuerst einen Arbeitsbereich öffnen',
  'Code 模式': 'Code-Modus',

  // ── Babe page ──
  '欢迎来到 Babe 模式': 'Willkommen beim Babe-Modus',
  '请在设置中配置 TA 的形象，然后开始你们的对话。': 'Bitte konfiguriere in den Einstellungen das Aussehen und beginnt euer Gespräch.',
  '请在设置中配置 TA 的形象、名字和性格': 'Bitte konfiguriere in den Einstellungen Aussehen, Namen und Persönlichkeit',
  'TA 会有自己的记忆、好感度，甚至会主动找你聊天。': 'TAhat ein eigenes Gedächtnis, einen Zuneigungsgrad und kann von sich aus mit dir sprechen.',
  '对TA说点什么...': 'Sag etwas zu TA...',
  '让TA主动发消息': 'TA aktiv eine Nachricht senden lassen',
  'Babe 历史记录': 'Babe-Verlauf',
  '与 TA 的对话记忆（独立持久化）': 'Gesprächserinnerungen mit TA (unabhängig gespeichert)',
  '暂无 Babe 历史': 'Kein Babe-Verlauf',
  '在 Babe 模式中开始对话后会自动保存': 'Gespräche im Babe-Modus werden automatisch gespeichert',
  '欢迎回来': 'Willkommen zurück',
  '继续你们的对话吧~': 'Setzt euer Gespräch fort~',
  '新的开始': 'Neuer Anfang',
  '开始一段新的对话吧~': 'Beginne ein neues Gespräch~',
  '请先初始化 Babe 模式': 'Bitte zuerst Babe-Modus initialisieren',
  'TA 的心声': 'TAs Gedanken',
  '好感度': 'Zuneigung',
  '初始化 Babe 模式失败:': 'Babe-Modus-Initialisierung fehlgeschlagen:',
  'TA 还在回复中，请稍等...': 'TA antwortet noch, bitte warten...',
  '请先在设置中配置 LLM API': 'Bitte zuerst LLM-API in den Einstellungen konfigurieren',
  '发送失败:': 'Senden fehlgeschlagen:',
  '确定删除这段和 TA 的回忆吗？': 'Möchtest du diese Erinnerung mit TA wirklich löschen?',
  '删除确认': 'Löschbestätigung',

  // ── History ──
  '对话历史': 'Chat-Verlauf',
  '查看和继续以前的对话': 'Frühere Gespräche ansehen und fortsetzen',
  '暂无对话历史': 'Kein Chat-Verlauf',
  '继续对话': 'Gespräch fortsetzen',
  '导出为JSON': 'Als JSON exportieren',
  '导出为Markdown': 'Als Markdown exportieren',
  '确认删除此远端对话？': 'Dieses Remote-Gespräch wirklich löschen?',
  '加载远程历史…': 'Remote-Verlauf wird geladen...',
  '远端暂无对话历史': 'Kein Remote-Gesprächsverlauf',
  '未知时间': 'Unbekannte Zeit',
  '条消息': ' Nachrichten',
  '删除对话': 'Gespräch löschen',
  '确定要删除这轮对话吗？': 'Dieses Gespräch wirklich löschen?',

  // ── Tools page ──
  '工具管理': 'Werkzeugverwaltung',
  '启用或禁用AI Agent可以使用的工具': 'Werkzeuge des KI-Agenten aktivieren/deaktivieren',
  '自动优化工具选择': 'Tool-Auswahl automatisch optimieren',
  '显示模式：': 'Anzeigemodus:',
  'Chat 模式工具': 'Chat-Modus-Werkzeuge',
  'Code 模式工具': 'Code-Modus-Werkzeuge',
  'Babe 模式工具': 'Babe-Modus-Werkzeuge',
  '已启用': 'Aktiviert',
  '整组开关': 'Gruppenumschalter',
  '来自 MCP 服务器:': 'Von MCP-Server:',
  '动态': 'Dynamisch',
  '开启自动优化工具选择': 'Auto-Tool-Optimierung aktivieren',
  '开启后，每个新对话首条消息前会先优化本次可用工具集合...': 'Wenn aktiviert, werden Werkzeuge vor der ersten Nachricht jedes neuen Gesprächs optimiert...',
  '工具上下文': 'Werkzeugkontext',
  '当前优化:': 'Aktuelle Optimierung:',
  '未执行': 'Nicht ausgeführt',
  '优化后': 'Nach Optimierung',
  '已优化': 'Optimiert',
  'tokens（节省 ~': 'Tokens (gespart ~',
  'MCP动态': 'MCP dynamisch',
  '个工具': ' Werkzeuge',
  '手动触发工具重优化': 'Manuelle Tool-Neuoptimierung ausgelöst',
  '用户手动点击"重新优化工具选择"': 'Benutzer klickte auf "Tool-Auswahl neu optimieren"',

  // ── Skills page ──
  '技能管理': 'Fertigkeitsverwaltung',
  '管理AI Agent的技能，也可以让Agent自动生成': 'Fertigkeiten des KI-Agenten verwalten oder automatisch generieren lassen',
  '导入 SKILL.md': 'SKILL.md importieren',
  '添加技能': 'Fertigkeit hinzufügen',
  '暂无技能，点击上方按钮添加': 'Keine Fertigkeiten, oben klicken zum Hinzufügen',
  '暂无技能，点击上方按钮添加或导入 SKILL.md': 'Keine Fertigkeiten, oben klicken zum Hinzufügen oder SKILL.md importieren',
  '技能名称': 'Fertigkeitsname',
  '描述': 'Beschreibung',
  '系统提示词': 'System-Prompt',
  '编辑技能': 'Fertigkeit bearbeiten',
  '标准 Skill': 'Standard-Fertigkeit',
  '自定义': 'Benutzerdefiniert',
  '更新成功：': 'Aktualisierung erfolgreich:',
  '导入成功：': 'Import erfolgreich:',
  '导入失败：': 'Import fehlgeschlagen:',
  '技能导入结果：': 'Fertigkeits-Importergebnis:',
  '更新技能失败': 'Fertigkeit konnte nicht aktualisiert werden',
  '创建技能失败': 'Fertigkeit konnte nicht erstellt werden',

  // ── Knowledge page ──
  'AI Agent的知识存储，支持搜索和管理': 'Wissensbasis des KI-Agenten, durchsuchbar und verwaltbar',
  '搜索知识库...': 'Wissensbasis durchsuchen...',
  '导入文件': 'Datei importieren',
  '知识库为空，AI Agent会在工作中自动积累知识': 'Wissensbasis ist leer, KI-Agent sammelt Wissen bei der Arbeit',
  '知识库为空': 'Wissensbasis ist leer',
  '确定要删除这条知识吗？': 'Dieses Wissen wirklich löschen?',

  // ── Memory page ──
  '长期记忆': 'Langzeitgedächtnis',
  'AI Agent的持久化记忆，帮助它记住重要信息': 'Persistentes Gedächtnis des KI-Agenten für wichtige Informationen',
  '搜索记忆...': 'Gedächtnis durchsuchen...',
  '暂无长期记忆，AI Agent会在工作中自动记录': 'Kein Langzeitgedächtnis, KI-Agent zeichnet bei der Arbeit auf',
  '暂无长期记忆': 'Kein Langzeitgedächtnis',
  '确定要删除这条记忆吗？': 'Diese Erinnerung wirklich löschen?',
  '编辑记忆': 'Gedächtnis bearbeiten',
  '内容': 'Inhalt',
  '输入记忆内容...': 'Erinnerungsinhalt eingeben...',
  '标签（用逗号分隔）': 'Tags (kommagetrennt)',
  '例如：项目,灵感': 'z.B. Projekt, Inspiration',

  // ── Settings tabs ──
  'AI 形象': 'KI-Persona',
  'Babe 模式': 'Babe-Modus',
  '个人资料': 'Profil',
  '用量统计': 'Nutzung',
  '生图': 'Bildgen',
  '主题': 'Design',
  '语言': 'Sprache',
  '网络': 'Netzwerk',
  '熵源': 'Entropie',
  'TRNG固件': 'TRNG-Firmware',
  '安全': 'Sicherheit',
  '邮箱': 'E-Mail',
  'Web控制': 'Web-Steuerung',

  // ── Settings: AI Persona ──
  'AI 形象设定': 'KI-Persona-Einstellungen',
  '名字': 'Name',
  '头像': 'Avatar',
  '选择图片': 'Bild auswählen',
  '清除头像': 'Avatar löschen',
  '你的全能AI伙伴~': 'Dein Allround-KI-Partner~',
  '人称代词': 'Pronomen',
  '性格': 'Persönlichkeit',
  '活泼可爱、热情友善': 'Lebhaft, süß, warm und freundlich',
  '自定义提示词 (追加到系统提示词末尾)': 'Benutzerdefinierter Prompt (an System-Prompt angehängt)',
  '你可以在这里添加额外的性格描述、说话风格等...': 'Füge zusätzliche Persönlichkeitsbeschreibungen, Sprechstil usw. hinzu...',
  '命运之牌': 'Tarotkarte',
  '关闭后隐藏所有命运之牌相关 UI（后端抽牌逻辑不变）': 'Alle Tarot-bezogenen UI ausblenden wenn aus (Backend-Logik unverändert)',

  // ── Settings: Babe ──
  'Babe 模式形象': 'Babe-Modus-Persona',
  '配置恋爱模式的 AI 形象。TA 会有独立的历史记录、好感度和记忆。': 'KI-Persona für Begleiter-Modus konfigurieren. TA hat unabhängigen Verlauf, Zuneigung und Gedächtnis.',
  '姓名': 'Name',
  '性别': 'Geschlecht',
  '女': 'Weiblich',
  '男': 'Männlich',
  '年龄': 'Alter',
  '如：22岁': 'z.B. 22 Jahre',
  '性格特征': 'Persönlichkeitsmerkmale',
  '如：温柔、活泼、有点小傲娇': 'z.B. sanft, lebhaft, etwas tsundere',
  'Persona / 背景': 'Persona / Hintergrund',
  '描述TA的背景故事、说话风格、喜好等...': 'Beschreibe TAs Hintergrund, Sprechstil, Vorlieben...',
  '称呼用户的方式': 'Wie TA dich nennt',
  'TA怎么称呼你？如：亲爱的、宝宝': 'Wie nennt TA dich? z.B. Schatz, Baby',
  '主动消息频率': 'Proaktive Nachrichten-Frequenz',
  '关闭主动消息': 'Proaktive Nachrichten deaktivieren',
  '30 分钟': '30 Minuten',
  '1 小时': '1 Stunde',
  '3 小时': '3 Stunden',
  '6 小时': '6 Stunden',
  '12 小时': '12 Stunden',
  '24 小时': '24 Stunden',
  'TA 会定时主动找你聊天（仅在 Babe 模式且应用打开时生效）': 'TA schreibt dir regelmäßig proaktiv (nur im Babe-Modus bei offener App)',
  '初始好感度': 'Anfangs-Zuneigung',
  '每个新对话的起始好感度（0-100）': 'Start-Zuneigung für jedes neue Gespräch (0-100)',

  // ── Settings: Profile ──
  '设置你自己的个人信息，AI 会记住你的名字和简介。': 'Eigenes Profil einrichten. KI merkt sich Namen und Bio.',
  '昵称': 'Spitzname',
  '填写你的昵称': 'Spitzname eingeben',
  'Bio (个人简介)': 'Bio',
  '写几句话介绍一下自己吧~': 'Schreibe ein paar Worte über dich~',

  // ── Settings: LLM ──
  'LLM 配置': 'LLM-Konfiguration',
  '接入方式': 'Anbieter',
  'OpenAI 兼容': 'OpenAI-kompatibel',
  'Anthropic 兼容': 'Anthropic-kompatibel',
  'OpenCode Zen (免费模型可用)': 'OpenCode Zen (kostenlose Modelle verfügbar)',
  'OpenAI兼容：标准 chat/completions；Anthropic兼容：messages API；OpenCode Zen：自动路由': 'OpenAI-kompatibel: Standard chat/completions; Anthropic-kompatibel: messages API; OpenCode Zen: Auto-Routing',
  'API URL': 'API-URL',
  'API Key': 'API-Key',
  '模型': 'Modell',
  '点击右侧按钮自动获取模型列表，也可手动输入': 'Klicke die Schaltfläche zum Abrufen der Modellliste oder manuell eingeben',
  '获取模型列表': 'Modelle abrufen',
  'Zen API Key': 'Zen-API-Key',
  '使用免登录公共 Key 调用 6 个免费模型': 'Public Key für 6 kostenlose Modelle ohne Anmeldung nutzen',
  '生成新 Key': 'Neuen Key generieren',
  '从': 'Von',
  '获取，按量付费，含免费模型。点击「生成新 Key」可免登录使用 6 个限时免费模型（key=public）': '. Pay-as-you-go, inklusive kostenlose Modelle. Klicke "Neuen Key generieren" für 6 zeitlich begrenzte kostenlose Modelle (key=public)',
  '点击刷新获取可用模型列表': 'Klicken zum Aktualisieren der verfügbaren Modelle',
  '推理强度 (仅支持的模型生效)': 'Reasoning-Aufwand (nur unterstützte Modelle)',
  '低': 'Niedrig',
  '中': 'Mittel',
  '高': 'Hoch',
  'OpenAI o系列/GPT-5 用 reasoning_effort，Anthropic Claude 用 thinking budget_tokens': 'OpenAI o-Serie/GPT-5 nutzt reasoning_effort, Anthropic Claude nutzt thinking budget_tokens',
  '温度': 'Temperatur',
  '最大上下文长度': 'Max. Kontextlänge',
  'LLM返回Token上限': 'Max. Antwort-Tokens',
  '每日最大Token用量 (0为不限制)': 'Tägliches Token-Limit (0 = unbegrenzt)',
  '例如 200000': 'z.B. 200000',
  '今日已用: 0': 'Heute genutzt: 0',
  '流式响应 (实时渲染Token)': 'Streaming-Antwort (Echtzeit-Token-Rendering)',
  '开启后助手回复将逐字显示，关闭则等待完整回复再显示': 'Wenn aktiviert, erscheinen Antworten Wort für Wort; deaktiviert wartet auf vollständige Antwort',
  '请求失败自动重试次数': 'Auto-Wiederholung bei Fehlern',
  '指数退避重试，应对 429/529/网络错误': 'Exponentielles Backoff für 429/529/Netzwerkfehler',
  '请求超时 (秒, 0为不限制)': 'Request-Timeout (Sekunden, 0 = unbegrenzt)',
  '529 过载时回退模型 (可选)': '529-Überlast-Fallback-Modell (optional)',
  '例如 gpt-4o-mini': 'z.B. gpt-4o-mini',
  '连续 529 过载后自动切换到此模型': 'Auto-Wechsel zu diesem Modell nach aufeinanderfolgenden 529-Überlastungen',

  // ── Settings: Usage ──
  '从API返回的真实 usage 数据汇总（prompt + completion tokens）。': 'Echte usage-Daten aus API-Antworten (prompt + completion tokens).',
  '今日': 'Heute',
  '本周(7天)': 'Diese Woche (7 Tage)',
  '本月(30天)': 'Dieser Monat (30 Tage)',
  '趋势': 'Trend',
  '按模型': 'Nach Modell',
  '按小时趋势': 'Stündlicher Trend',
  '按日趋势': 'Täglicher Trend',
  '总 Token': 'Gesamt-Token',
  '提示 Token': 'Prompt-Token',
  '生成 Token': 'Completion-Token',
  '请求次数': 'Anzahl Anfragen',
  'tokens ·': 'Tokens ·',
  '次': 'mal',
  '今日已用:': 'Heute genutzt:',
  '(接近限制': '(nahe Limit',
  '使用量已重置': 'Nutzung wurde zurückgesetzt',
  '重置每日使用量': 'Tägliche Nutzung zurücksetzen',
  '重置今日的Token用量和图片生成数统计，谨慎使用。': 'Setzt heutige Token-Nutzung und Bildgenerierung zurück. Mit Vorsicht verwenden.',
  '确定要重置每日使用量统计吗？': 'Tägliche Nutzungsstatistik wirklich zurücksetzen?',
  '这将清零今日的Token用量和图片生成数。': 'Dies setzt heutige Token-Nutzung und Bildgenerierung auf Null.',
  '⚠️ 已达到今日LLM Token上限': '⚠️ Tages-Limit für LLM-Tokens erreicht',
  '⚠️ 警告：今日Token已使用': '⚠️ Warnung: Heutige Tokens genutzt',

  // ── Settings: Image Gen ──
  '生图模型配置': 'Bildgenerierungs-Konfiguration',
  '图像分辨率': 'Bildauflösung',
  '每日最大生成图片数 (0为不限制)': 'Tägliches Bild-Limit (0 = unbegrenzt)',
  '例如 50': 'z.B. 50',

  // ── Settings: Theme ──
  '外观模式': 'Erscheinungsmodus',
  '跟随系统': 'System folgen',
  '浅色': 'Hell',
  '深色': 'Dunkel',
  '强调色': 'Akzentfarbe',
  '背景色': 'Hintergrundfarbe',
  '推荐配色方案': 'Empfohlene Schemas',
  // Color scheme names (German)
  '天空蓝': 'Himmelblau',
  '薄荷绿': 'Minzgrün',
  '珊瑚橙': 'Korallenorange',
  '海洋蓝': 'Ozeanblau',
  '青碧': 'Cyan',
  '玫瑰红': 'Rosenrot',
  '清新白': 'Frisch Weiß',
  '冰蓝': 'Eisblau',
  '嫩叶绿': 'Blattgrün',
  '浅樱': 'Kirschblüte',
  '深邃蓝': 'Tiefblau',
  '墨黑': 'Tintenschwarz',
  '清新蓝': 'Frischblau',
  '自然绿': 'Naturgrün',
  '海洋': 'Ozean',
  '珊瑚': 'Koralle',
  '紫雾': 'Purpeldunst',
  '粉黛': 'Rosa Schönheit',
  '玫瑰': 'Rose',
  '浅海': 'Flaches Meer',
  '薄荷': 'Minze',
  '柔金': 'Sanftes Gold',
  '石榴': 'Granatapfel',
  '湖光': 'Seeschein',
  '蔚蓝': 'Azur',
  '薰衣': 'Lavendel',
  '暖橙': 'Warmes Orange',
  '清绿': 'Klares Grün',
  '晴空': 'Klarer Himmel',
  '淡紫': 'Blasslila',
  '薄荷冰': 'Minzeis',
  '柠檬': 'Zitrone',
  '杏橙': 'Aprikosenorange',
  '清澈蓝': 'Klares Blau',
  '樱红': 'Kirschrot',
  '天光': 'Himmelslicht',
  '嫩绿': 'Zartgrün',
  '紫晶': 'Amethyst',
  '青松': 'Kiefer',
  '焦糖': 'Karamell',
  '赤霞': 'Rote Glut',
  '海风': 'Meeresbrise',
  '冷灰': 'Kühles Grau',
  '暗夜玫瑰': 'Nachtrose',
  '深湖': 'Tiefsee',
  '深紫': 'Tiefviolett',
  '莓夜': 'Beerennacht',
  '深海蓝': 'Tiefseeblau',
  '松夜': 'Kiefernnacht',
  '暗金': 'Dunkles Gold',
  '赤夜': 'Rote Nacht',
  '夜航': 'Nachtfahrt',
  '深林': 'Tiefer Wald',
  '暖夜': 'Warme Nacht',
  '夜紫': 'Nachtviolett',
  '夜绯': 'Nachtfeuer',
  '深蓝': 'Dunkelblau',
  '墨青': 'Tintencyan',
  '深柠': 'Tiefzitrone',
  '炉火': 'Herdfeuer',
  '午夜蓝': 'Mitternachtsblau',
  '暗樱': 'Dunkle Kirsche',
  '深绿松': 'Tief Türkis',
  '翠夜': 'Smaragdnacht',
  '夜晶': 'Nachtkristall',
  '深松': 'Tiefkiefer',
  '暗橙': 'Dunkles Orange',
  '暗红': 'Dunkelrot',
  '夜石': 'Nachtstein',
  '深灰': 'Tiefgrau',
  '琥珀夜': 'Bernsteinnacht',
  '绯红夜': 'Purpurnacht',
  '极夜蓝': 'Polarnachtblau',
  '深绿': 'Tiefgrün',
  '夜紫罗': 'Nachtveilchen',

  // ── Settings: Language ──
  '界面语言': 'Oberflächensprache',
  '选择应用界面和AI回复使用的语言': 'Sprache für Oberfläche und KI-Antworten wählen',
  '简体中文': '简体中文',
  '语言设置已保存，部分文本将在下次启动后完全生效': 'Spracheinstellung gespeichert. Einige Texte werden nach Neustart vollständig angewendet.',

  // ── Settings: Network ──
  '网络代理': 'Netzwerk-Proxy',
  '代理模式': 'Proxy-Modus',
  '不使用代理': 'Kein Proxy',
  '系统代理': 'System-Proxy',
  '手动配置': 'Manuell',
  'HTTP 代理': 'HTTP-Proxy',
  'HTTP和HTTPS请求使用的代理地址': 'Proxy-Adresse für HTTP- und HTTPS-Anfragen',
  'HTTPS 代理': 'HTTPS-Proxy',
  '可选，留空则使用HTTP代理设置': 'Optional, verwendet HTTP-Proxy wenn leer',
  '不代理的地址': 'Kein-Proxy-Adressen',
  '逗号分隔的不使用代理的主机名或IP': 'Kommagetrennte Hostnamen oder IPs ohne Proxy',
  '代理设置将影响所有网络请求（API调用、网页抓取等）。重启应用后生效。': 'Proxy-Einstellungen beeinflussen alle Netzwerkanfragen (API-Aufrufe, Web-Scraping usw.). Wirkt nach Neustart.',

  // ── Settings: Entropy ──
  '熵源设定': 'Entropie-Einstellungen',
  '为命运之牌（Agent + SubAgent 抽牌、工具调用抽牌）设定随机数来源。': 'Zufallszahlenquelle für Tarot-Kartenziehen festlegen.',
  '熵源类型': 'Entropie-Typ',
  '系统级密码学安全伪随机': 'System-CSPRNG',
  'TRNG': 'TRNG',
  'ESP32 硬件真随机数': 'ESP32-Hardware-TRNG',
  'TRNG 设备配置': 'TRNG-Gerätekonfiguration',
  '连接方式': 'Verbindungsmethode',
  '网络 API': 'Netzwerk-API',
  '串口': 'Serieller Anschluss',
  '设备 IP 地址': 'Geräte-IP-Adresse',
  '设备端口': 'Geräte-Port',
  '选择串口...': 'Anschluss auswählen...',
  '波特率': 'Baudrate',
  '测试 TRNG 连接': 'TRNG-Verbindung testen',
  '发现': 'Gefunden',
  '个串口': ' Anschlüsse',
  '未检测到串口': 'Keine seriellen Anschlüsse erkannt',
  '串口列表获取失败': 'Serielle Anschlüsse konnten nicht abgerufen werden',
  'serialport 未安装，请先安装依赖': 'serialport nicht installiert, bitte zuerst Abhängigkeiten installieren',
  '正在测试...': 'Teste...',
  '连接成功! 抽到:': 'Verbindung erfolgreich! Gezogen:',
  '熵源:': 'Entropie-Quelle:',
  '连接失败:': 'Verbindung fehlgeschlagen:',

  // ── Settings: TRNG Firmware ──
  'ESP32 TRNG 固件烧录教程': 'ESP32-TRNG-Firmware-Flash-Anleitung',
  '如果你需要使用 TRNG 硬件真随机数生成器，需要先将固件烧录到 ESP32 开发板上。': 'Wenn du TRNG-Hardware-Zufallsgenerator nutzen willst, flashe zuerst die Firmware auf ein ESP32-Board.',
  '步骤 1：导出固件源代码': 'Schritt 1: Firmware-Quellcode exportieren',
  '导出固件源码到指定目录': 'Firmware-Quellcode in Verzeichnis exportieren',
  '导出 CIBYP-TRNG 固件源代码，以便在 Arduino IDE 中打开。': 'CIBYP-TRNG-Firmware-Quellcode für Arduino IDE exportieren.',
  '步骤 2：安装 Arduino IDE 2': 'Schritt 2: Arduino IDE 2 installieren',
  '下载 Arduino IDE 2.x': 'Arduino IDE 2.x herunterladen',
  '2. 安装完成后打开 Arduino IDE': '2. Arduino IDE nach Installation öffnen',
  '步骤 3：安装 ESP32 开发板支持': 'Schritt 3: ESP32-Board-Unterstützung installieren',
  '4. 安装 "esp32 by Espressif Systems"': '4. "esp32 by Espressif Systems" installieren',
  '步骤 4：配置和烧录': 'Schritt 4: Konfigurieren und Flashen',
  '6. 等待编译和烧录完成': '6. Auf Kompilierung und Flashen warten',
  '常见问题': 'FAQ',
  '烧录失败怎么办？': 'Flashen fehlgeschlagen?',
  '- 确认 USB 线支持数据传输（不是充电线）': '- Bestätigen, dass USB-Kabel Daten unterstützt',
  '- 确认已选择正确的 COM 端口': '- Richtigen COM-Port bestätigen',
  '- 尝试按住 ESP32 的 BOOT 按钮再点击 Upload': '- ESP32-BOOT-Taste beim Upload gedrückt halten',
  '- 降低 Upload Speed 到 115200': '- Upload-Speed auf 115200 senken',
  '无法连接 WiFi？': 'WiFi-Verbindung fehlgeschlagen?',
  '- 检查 WiFi SSID 和密码是否正确': '- WiFi-SSID und Passwort prüfen',
  '- 确认 WiFi 是 2.4GHz（ESP32 不支持 5GHz）': '- WiFi muss 2.4GHz sein (ESP32 unterstützt kein 5GHz)',
  '- 查看串口监视器的日志信息': '- Seriellen Monitor-Log prüfen',
  '串口无数据输出？': 'Keine serielle Ausgabe?',
  '- 确认波特率设置正确（默认 115200）': '- Baudrate bestätigen (Standard 115200)',
  '- 检查 USB 驱动是否正确安装': '- USB-Treiber-Installation prüfen',
  '- 尝试重新插拔 USB 线或重启 ESP32': '- USB neu anschließen oder ESP32 neu starten',
  '更多信息': 'Weitere Infos',
  '请参阅导出的固件目录中的 README.md 文件。': 'Siehe README.md im exportierten Firmware-Verzeichnis.',
  '固件源码已导出到：': 'Firmware-Quellcode exportiert nach:',
  '导出成功': 'Export erfolgreich',
  '请在 Arduino IDE 中打开 CIBYP-TRNG.ino 文件。': 'CIBYP-TRNG.ino in Arduino IDE öffnen.',
  '导出失败：': 'Export fehlgeschlagen:',
  '未知错误': 'Unbekannter Fehler',
  '导出失败': 'Export fehlgeschlagen',

  // ── Settings: Security ──
  '自动批准敏感操作': 'Sensible Operationen auto-genehmigen',
  '开启后，AI Agent将自动执行包括文件删除、终端命令等敏感操作，存在安全风险。请确保你信任当前运行的任务。': 'KI-Agent führt sensible Operationen (Dateilöschung, Terminal) automatisch aus. Sicherheitsrisiko. Nur bei vertrauenswürdigen Aufgaben.',
  '使用量管理': 'Nutzungsverwaltung',
  '开启自动批准敏感操作后，AI Agent将无需确认即可执行文件删除、终端命令等危险操作。': 'Mit Auto-Genehmigung führt der KI-Agent gefährliche Operationen ohne Bestätigung aus.',
  '确定要开启吗？': 'Wirklich aktivieren?',

  // ── Settings: MCP ──
  'MCP 服务器': 'MCP-Server',
  'Model Context Protocol (MCP) 允许 AI Agent 连接外部工具服务器，扩展能力。添加服务器后点击连接即可使用。': 'MCP ermöglicht die Verbindung zu externen Werkzeugservern. Server hinzufügen und auf Verbinden klicken.',
  '添加 MCP 服务器': 'MCP-Server hinzufügen',
  '服务器名称': 'Servername',
  '启动命令': 'Startbefehl',
  '参数 (JSON 数组，可选)': 'Argumente (JSON-Array, optional)',
  '环境变量 (JSON 对象，可选)': 'Umgebungsvariablen (JSON-Objekt, optional)',
  '工作目录 (可选)': 'Arbeitsverzeichnis (optional)',
  '留空则使用默认目录': 'Verwendet Standardverzeichnis wenn leer',
  '启动时自动连接': 'Auto-Verbinden beim Start',
  '已连接工具': 'Verbundene Werkzeuge',
  '暂无已连接的 MCP 服务器': 'Keine verbundenen MCP-Server',
  '暂无 MCP 服务器配置': 'Keine MCP-Server-Konfigurationen',
  '暂无已连接的工具': 'Keine verbundenen Werkzeuge',
  '加载失败:': 'Laden fehlgeschlagen:',
  '名称和命令不能为空': 'Name und Befehl dürfen nicht leer sein',
  '参数格式错误(需JSON数组)': 'Ungültiges Argumentformat (JSON-Array erforderlich)',
  '环境变量格式错误(需JSON对象)': 'Ungültiges Umgebungsvariablenformat (JSON-Objekt erforderlich)',
  '添加失败': 'Hinzufügen fehlgeschlagen',
  '已连接': 'Verbunden',
  '连接中...': 'Verbinde...',
  '错误': 'Fehler',
  '未连接': 'Getrennt',

  // ── Settings: Email ──
  '实验性功能': 'Experimentelle Funktion',
  '邮件控制功能尚处于实验阶段，可能不稳定或不完全可用。请谨慎使用。': 'E-Mail-Steuerung ist experimentell und möglicherweise instabil. Mit Vorsicht verwenden.',
  '邮件模式': 'E-Mail-Modus',
  '控制模式': 'Steuerungsmodus',
  '只发（发送对话摘要）': 'Nur Senden (Gesprächszusammenfassungen)',
  '只收（接收邮件指令）': 'Nur Empfangen (E-Mail-Befehle)',
  '发+收（完整控制）': 'Senden + Empfangen (Vollständig)',
  'SMTP 发信配置': 'SMTP-Sende-Konfiguration',
  'SMTP 服务器': 'SMTP-Server',
  '端口': 'Port',
  '使用 TLS/SSL': 'TLS/SSL verwenden',
  'IMAP 收信配置': 'IMAP-Empfangs-Konfiguration',
  'IMAP 服务器': 'IMAP-Server',
  '使用 TLS': 'TLS verwenden',
  '帐号凭据': 'Konto-Zugangsdaten',
  '邮箱帐号': 'E-Mail-Konto',
  '授权码 / 密码': 'Auth-Code / Passwort',
  '请使用应用专用密码': 'App-spezifisches Passwort verwenden',
  '用户邮箱地址（你自己的邮箱，用于接收和发送指令）': 'Deine E-Mail-Adresse (für Befehle)',
  'TOTP 两步验证': 'TOTP 2FA',
  '用于邮件审批验证。点击生成密钥后，请用手机验证器App（如 Microsoft Authenticator、Google Authenticator）扫描二维码。': 'Für E-Mail-Genehmigung. QR-Code mit Authenticator-App scannen.',
  '生成 TOTP 密钥': 'TOTP-Schlüssel generieren',
  '输入6位验证码': '6-stelligen Code eingeben',
  '当前密钥': 'Aktueller Schlüssel',
  '尚未生成': 'Noch nicht generiert',
  '邮件控制选项': 'E-Mail-Steuerungsoptionen',
  '轮询间隔（秒）': 'Polling-Intervall (Sekunden)',
  '审批邮件重发间隔（分钟）': 'Genehmigungs-Weiterleitungsintervall (Minuten)',
  '最大重发次数': 'Max. Weiterleitungen',
  '启用管理': 'Verwaltung aktivieren',
  '启用邮件控制': 'E-Mail-Steuerung aktivieren',
  '✅ 验证通过': '✅ Verifizierung erfolgreich',
  '❌ 验证失败': '❌ Verifizierung fehlgeschlagen',
  '正在测试连接...': 'Verbindung wird getestet...',
  '✅ 连接成功。SMTP:': '✅ Verbindung erfolgreich. SMTP:',
  'IMAP:': 'IMAP:',
  '❌ 连接失败:': '❌ Verbindung fehlgeschlagen:',
  '✅ 设置已保存': '✅ Einstellungen gespeichert',
  '邮件轮询已启动': 'E-Mail-Polling gestartet',
  '来自邮件': 'Aus E-Mail',
  '发件人:': 'Von:',
  '主题:': 'Betreff:',
  '无主题': 'Kein Betreff',
  '已停止': 'Gestoppt',
  '❌ 停止失败:': '❌ Stoppen fehlgeschlagen:',
  '❌ 启动失败:': '❌ Starten fehlgeschlagen:',
  '未运行': 'Nicht aktiv',
  '✅ 运行中: http://localhost:': '✅ Läuft: http://localhost:',
  '密钥:': 'Schlüssel:',
  'TOTP 生成失败:': 'TOTP-Generierung fehlgeschlagen:',

  // ── Settings: Web Control ──
  'Web 远程控制': 'Web-Fernsteuerung',
  '通过任何浏览器远程控制 AI 助手。支持发消息、审批工具、查看对话历史。': 'KI-Assistent über jeden Browser fernsteuern. Unterstützt Nachrichten, Werkzeug-Genehmigung und Verlauf.',
  '注意：': 'Hinweis:',
  '独立窗口小游戏（飞花令/三国杀/谁是卧底）在Web控制模式下不可用，GeoGebra仅在主机运行。': 'Eigenständige Spielfenster sind im Web-Steuerungsmodus nicht verfügbar. GeoGebra läuft nur auf dem Host.',
  '访问安全': 'Zugriffssicherheit',
  '访问密码': 'Zugriffspasswort',
  '设置访问密码': 'Zugriffspasswort festlegen',
  '启用 2FA 两步验证': '2FA aktivieren',
  '服务器设置': 'Server-Einstellungen',
  '启用 Web 控制': 'Web-Steuerung aktivieren',
  '启动时自动开启 Web 控制': 'Beim Start automatisch aktivieren',

  // ── Settings: Playwright ──
  'Playwright 浏览器设置': 'Playwright-Browser-Einstellungen',
  '配置内置 Playwright 浏览器的启动方式。可选择使用系统安装的浏览器或指定浏览器二进制文件路径。': 'Startmethode des integrierten Playwright-Browsers konfigurieren. Systembrowser oder benutzerdefinierten Pfad wählen.',
  '浏览器语言会自动跟随当前 App 语言设置。': 'Browsersprache folgt automatisch der App-Spracheinstellung.',
  '浏览器来源': 'Browser-Quelle',
  '浏览器模式': 'Browser-Modus',
  '自动搜索（优先 Edge → Chrome → 内置 Chromium）': 'Automatische Suche (Edge → Chrome → integriertes Chromium)',
  '使用 Microsoft Edge': 'Microsoft Edge verwenden',
  '使用 Google Chrome': 'Google Chrome verwenden',
  '使用内置 Chromium': 'Integriertes Chromium verwenden',
  '自定义浏览器路径': 'Benutzerdefinierter Browser-Pfad',
  '浏览器可执行文件路径': 'Pfad zur Browser-Executable',
  '已检测到的浏览器': 'Erkannte Browser',
  '点击下方按钮搜索系统浏览器...': 'Klicken Sie auf die Schaltfläche unten, um nach Systembrowsern zu suchen...',
  '搜索浏览器': 'Browser suchen',
  '浏览器语言': 'Browsersprache',
  '浏览器语言跟随 App 语言': 'Browsersprache folgt App-Sprache',
  '启用后，内置浏览器将使用与 App 相同的语言（zh-CN/en/de）': 'Wenn aktiviert, verwendet der integrierte Browser dieselbe Sprache wie die App (zh-CN/en/de)',
  '启动参数': 'Startargumente',
  '额外启动参数（可选，每行一个）': 'Zusätzliche Startargumente (optional, eines pro Zeile)',
  '测试启动': 'Teststart',
  '保存设置': 'Einstellungen speichern',
  '选择浏览器可执行文件': 'Browser-Executable auswählen',
  '可执行文件': 'Ausführbare Dateien',
  '所有文件': 'Alle Dateien',
  '搜索中...': 'Suche...',
  '未检测到已安装的浏览器': 'Keine installierten Browser erkannt',
  '测试中...': 'Teste...',
  '测试成功': 'Test erfolgreich',
  '测试失败': 'Test fehlgeschlagen',
  '浏览器启动成功': 'Browser erfolgreich gestartet',
  '设置已保存': 'Einstellungen gespeichert',

  // ── About page ──
  '全自动AI Agent，帮助完成一切任务': 'Vollautonomer KI-Agent, der bei allem hilft',
  '由': 'Entwickelt von',
  '开发': '',
  '智能AI Agent': 'Intelligenter KI-Agent',
  '内置工具': 'Eingebaute Werkzeuge',
  '技能系统': 'Fertigkeitensystem',
  '上下文管理': 'Kontextverwaltung',

  // ── Modal dialogs ──
  '确认操作': 'Aktion bestätigen',
  '图片预览': 'Bildvorschau',
  '确定': 'OK',
  '例如：翻译助手': 'z.B. Übersetzungsassistent',
  '描述这个技能的功能...': 'Beschreibe die Funktion dieser Fertigkeit...',
  '你是一个专业的翻译助手...': 'Du bist ein professioneller Übersetzungsassistent...',
  '输入新名称:': 'Neuen Namen eingeben:',
  '重命名失败:': 'Umbenennen fehlgeschlagen:',
  '复制路径': 'Pfad kopieren',
  '在资源管理器打开': 'Im Explorer öffnen',
  '确认删除': 'Löschen bestätigen',
  '确定删除': 'Löschen bestätigen',
  '吗？此操作不可恢复。': '? Diese Aktion kann nicht rückgängig gemacht werden.',
  '删除失败:': 'Löschen fehlgeschlagen:',
  '该文件已在上下文中': 'Diese Datei ist bereits im Kontext',
  '从上下文移除': 'Aus Kontext entfernen',
  '添加到上下文': 'Zum Kontext hinzufügen',
  '重命名': 'Umbenennen',

  // ── Onboarding wizard ──
  '设定你的 AI 伙伴': 'Richte deinen KI-Partner ein',
  '给 AI 一个形象和性格，让对话更自然': 'Gib der KI ein Aussehen und eine Persönlichkeit für natürliche Gespräche',
  '移除': 'Entfernen',
  'Ta / 他 / 她': 'Er / Sie / Sie',
  '性格特点': 'Persönlichkeitsmerkmale',
  'Persona（自定义提示，可选）': 'Persona (benutzerdefinierter Prompt, optional)',
  '描述 AI 的背景、风格等': 'Beschreibe den Hintergrund der KI, Stil usw.',
  '告诉 AI 你是谁': 'Sag der KI, wer du bist',
  '你的形象信息仅本地保存，用于个性化称呼': 'Deine Profilinformationen werden lokal gespeichert',
  '你的名字': 'Dein Name',
  '配置 AI 大脑': 'KI-Gehirn konfigurieren',
  '默认使用 OpenCode Zen（免费），自动选择 DeepSeek 模型，开箱即用': 'Standard: OpenCode Zen (kostenlos), wählt automatisch DeepSeek-Modell',
  'OpenCode Zen（推荐，免费）': 'OpenCode Zen (empfohlen, kostenlos)',
  '正在获取模型列表...': 'Modellliste wird abgerufen...',
  '跳过引导': 'Anleitung überspringen',
  '上一步': 'Zurück',
  '下一步': 'Weiter',
  '完成配置': 'Einrichtung abschließen',
  '1 / 3': '1 / 3',

  // ── Remote connection ──
  '已连接远程主机': 'Mit Remote-Host verbunden',
  '未连接远程主机': 'Nicht mit Remote-Host verbunden',
  '重新连接': 'Erneut verbinden',
  '重连': 'Erneut verbinden',
  '关闭横幅': 'Banner schließen',
  '正在连接远程主机…': 'Verbinde mit Remote-Host...',
  '远程连接断开，正在重连…': 'Remote-Verbindung verloren, verbinde erneut...',
  '远程连接错误': 'Remote-Verbindungsfehler',
  '连接失败，请检查地址或网络': 'Verbindung fehlgeschlagen, Adresse oder Netzwerk prüfen',
  'WebSocket 连接失败': 'WebSocket-Verbindung fehlgeschlagen',
  '登录失败': 'Anmeldung fehlgeschlagen',
  '认证失败': 'Authentifizierung fehlgeschlagen',
  '已连接，可远程操作': 'Verbunden, Fernsteuerung möglich',
  '请填写地址和密码': 'Bitte Adresse und Passwort eingeben',
  '未连接到远程主机': 'Nicht mit Remote-Host verbunden',
  '已有相同请求进行中': 'Selbe Anfrage läuft bereits',
  '请求超时': 'Anfrage-Timeout',
  '连接已断开': 'Verbindung getrennt',
  '连接远程 WebUI': 'Mit Remote-WebUI verbinden',
  '远程地址': 'Remote-Adresse',
  '访问密码': 'Zugriffspasswort',
  '远程 WebUI 的访问密码': 'Remote-WebUI-Zugriffspasswort',
  'TOTP 验证码（如远程启用了 2FA）': 'TOTP-Code (falls Remote 2FA aktiviert hat)',
  '可选': 'Optional',
  '输入远程 WebUI 的地址和密码，连接后可远程操作对方的 Agent。': 'Remote-WebUI-Adresse und Passwort eingeben, um den Remote-Agent zu steuern.',

  // ── Status / messages ──
  'AI 正在思考...': 'KI denkt nach...',
  '正在优化工具选择...': 'Tool-Auswahl wird optimiert...',
  '推理过程': 'Denkprozess',
  '逆位': 'Umgekehrt',
  '正位': 'Aufrecht',
  '[TRNG 硬件真随机]': '[TRNG-Hardware-Zufall]',
  '抽取了命运之牌：': 'Tarotkarte gezogen:',
  '子代理启动': 'Unter-Agent gestartet',
  '任务:': 'Aufgabe:',
  '子代理完成': 'Unter-Agent abgeschlossen',
  '子代理': 'Unter-Agent',
  '[错误]': '[Fehler]',
  '用户拒绝了操作': 'Benutzer hat abgelehnt',
  '连接中...': 'Verbinde...',
  '[Canvas 内容不可镜像]': '[Canvas-Inhalt kann nicht gespiegelt werden]',
  '上下文使用详情': 'Kontext-Nutzungsdetails',
  '系统指导': 'System-Anweisung',
  '工具定义': 'Werkzeugdefinitionen',
  '聊天记录': 'Chat-Verlauf',
  '工具结果': 'Werkzeugergebnisse',
  '总计': 'Gesamt',
  '上下文使用量:': 'Kontext-Nutzung:',
  '附件:': 'Anhänge:',
  '[附件上传失败:': '[Anhang-Upload fehlgeschlagen:',
  '[附件:': '[Anhang:',
  '已转换为文本文件：': 'In Textdatei konvertiert:',
  '调用工具:': 'Werkzeugaufruf:',
  '下载文件': 'Datei herunterladen',
  '[TRNG]': '[TRNG]',
  '飞花令': 'Blumenworte',
  '三国杀': 'Drei Reiche',
  '谁是卧底': 'Untercover',
  '经典诗词接龙游戏，各方轮流说出含有指定字的诗句': 'Klassisches Kettenreim-Spiel mit Gedichten',
  '经典卡牌对战游戏，选择武将、出牌博弈': 'Klassisches Kartenspiel mit Strategie',
  '经典社交推理游戏，通过描述找出卧底': 'Klassisches Sozial-Deduktions-Spiel',
  '参与 Agent 数量：': 'Anzahl KI-Spieler:',
  '忽略': 'Ignorieren',
  '开始游戏': 'Spiel starten',
  '已接受': 'Angenommen',
  '游戏结束:': 'Spiel beendet:',
  '暂无待办事项': 'Keine Aufgaben',
  '操作:': 'Aktion:',
  '参数:': 'Parameter:',
  '上下文使用量': 'Kontext-Nutzung',
  '已使用': 'Verwendet',
  '已停止': 'Gestoppt',
  '个内置工具': ' eingebaute Werkzeuge',

  // ── Code mode specific ──
  '开始新的编程任务': 'Neue Programmieraufgabe starten',
  '恢复': 'Wiederherstellen',
  'Monaco 编辑器加载失败:': 'Monaco-Editor-Laden fehlgeschlagen:',
  '无法读取文件:': 'Datei kann nicht gelesen werden:',
  '保存失败:': 'Speichern fehlgeschlagen:',
  '有未保存的更改，确定关闭吗？': 'Du hast ungespeicherte Änderungen. Trotzdem schließen?',
  '加载文件树...': 'Dateibaum wird geladen...',
  '无法读取文件树': 'Dateibaum kann nicht gelesen werden',
  '工作区:': 'Arbeitsbereich:',
  '条消息': ' Nachrichten',
  '工具审批：': 'Werkzeug-Genehmigung:',
  '批准': 'Genehmigen',
  '执行中...': 'Wird ausgeführt...',
  '完成': 'Fertig',
  '失败': 'Fehlgeschlagen',
  '错误:': 'Fehler:',

  // ── GeoGebra / Canvas / Spreadsheet ──
  'GeoGebra已显示': 'GeoGebra angezeigt',
  'GeoGebra 加载超时（30s），请检查网络是否能访问 www.geogebra.org': 'GeoGebra-Lade-Timeout (30s), Netzwerkzugang zu www.geogebra.org prüfen',
  'GeoGebra已启动': 'GeoGebra gestartet',
  'GeoGebra 注入失败:': 'GeoGebra-Injektion fehlgeschlagen:',
  'GeoGebra未初始化（applet 尚未加载完成）': 'GeoGebra nicht initialisiert (Applet noch nicht geladen)',
  '命令为空': 'Befehl ist leer',
  'GeoGebra 命令错误': 'GeoGebra-Befehlsfehler',
  'GeoGebra 错误': 'GeoGebra-Fehler',
  '命令未产生任何对象，可能语法错误：': 'Befehl hat kein Objekt erzeugt, möglicher Syntaxfehler:',
  '命令执行超时（懒加载模块未就绪）': 'Befehls-Timeout (Modul nicht bereit)',
  'GeoGebra未初始化': 'GeoGebra nicht initialisiert',
  '画布元素未找到': 'Canvas-Element nicht gefunden',
  '画布已初始化并清空': 'Canvas initialisiert und geleert',
  '画布未初始化': 'Canvas nicht initialisiert',
  '画布已清空': 'Canvas geleert',
  '对象ID': 'Objekt-ID',
  '已存在': 'Bereits vorhanden',
  '对象': 'Objekt',
  '已添加': 'Hinzugefügt',
  '不存在': 'Nicht vorhanden',
  '已更新': 'Aktualisiert',
  '已删除': 'Gelöscht',
  '画布或工作区路径未设置': 'Canvas oder Arbeitsbereich nicht festgelegt',
  'SVG已导出': 'SVG exportiert',
  '数据表格面板元素未找到': 'Tabellenkalkulations-Panel nicht gefunden',
  '数据表格已打开': 'Tabelle geöffnet',
  '已导入': 'Importiert',
  '个单元格': ' Zellen',

  // ── Questionnaire ──
  '上一题': 'Zurück',
  '下一题': 'Weiter',
  '提交': 'Absenden',
  '已提交': 'Eingereicht',
  '问卷已提交': 'Fragebogen eingereicht',
  '选项A': 'Option A',
  '选项B': 'Option B',
  '选项C': 'Option C',
  'D.': 'D.',
  '自定义选项': 'Benutzerdefinierte Option',
  '请选择一个选项，或填写自定义选项': 'Option auswählen oder eigene eingeben',
  '确认对话框未找到': 'Bestätigungsdialog nicht gefunden',
  '消息对话框未找到': 'Nachrichtendialog nicht gefunden',

  // ── File operations ──
  '图片已复制到剪贴板': 'Bild in Zwischenablage kopiert',
  '图片已保存到:': 'Bild gespeichert unter:',
  '复制失败:': 'Kopieren fehlgeschlagen:',
  '复制图片': 'Bild kopieren',
  '另存为': 'Speichern unter',
  '保存图片': 'Bild speichern',

  // ── Agent status messages ──
  '已替换': 'Ersetzt',
  '处匹配': ' Treffer',
  'LLM 请求失败（': 'LLM-Anfrage fehlgeschlagen (',
  '），第': '), Versuch ',
  '次重试': ' Wiederholung',
  's 后重试': 's Wiederholung in',
  '已自动压缩上下文（': 'Kontext automatisch komprimiert (',
  '当前使用': 'Aktuelle Nutzung ',
  '上下文压缩失败（': 'Kontext-Komprimierung fehlgeschlagen (',
  '上下文压缩异常（': 'Kontext-Komprimierung Ausnahme (',
  '⚠️ 上下文严重溢出，已强制截断最近4条消息': '⚠️ Kontext stark überlaufen, letzte 4 Nachrichten abgeschnitten',
  '已将新消息注入当前对话': 'Neue Nachrichten in aktuelles Gespräch injiziert',
  '流式请求失败，回退到普通模式：': 'Streaming-Anfrage fehlgeschlagen, Fallback auf Normalmodus: ',
  '已在本会话中禁用自动工具选择优化，所有已启用工具现在都可用。': 'Auto-Tool-Optimierung für diese Sitzung deaktiviert. Alle aktivierten Werkzeuge verfügbar.',
  '用户拒绝了此操作': 'Benutzer hat diese Aktion abgelehnt',
  '用户:': 'Benutzer:',
  'AI:': 'KI:',
  '中间部分已截断，共': 'Mitte abgeschnitten, insgesamt ',
  '字符': ' Zeichen',
  '文件已全量覆写': 'Datei vollständig überschrieben',
  'edits 必须是非空数组': 'edits muss ein nicht-leeres Array sein',
  '已应用': 'Angewendet',
  '处编辑': ' Bearbeitungen',
  '文件': 'Datei ',
  '已呈递给用户': ' dem Benutzer präsentiert',
  '技能': 'Fertigkeit',
  '已激活，prompt 已注入系统上下文': 'aktiviert, Prompt in Systemkontext injiziert',
  '技能已停用': 'Fertigkeit deaktiviert',
  '无激活技能': 'Keine aktiven Fertigkeiten',
  '画布功能未初始化': 'Canvas nicht initialisiert',
  '数据表格功能未初始化': 'Tabelle nicht initialisiert',
  '用户忽略了游戏邀请': 'Benutzer hat Spieleinladung ignoriert',
  '目标已设置:': 'Ziel gesetzt:',
  '当前没有活跃目标': 'Kein aktives Ziel',
  '目标已完成:': 'Ziel erreicht:',
  '模式→': 'Modus→',
  '配色→': 'Schema→',
  '强调色→': 'Akzent→',
  '子代理完成了任务但没有文本回复': 'Unter-Agent abgeschlossen, aber keine Textantwort',
  '游戏玩家': 'Spieler',
  '位 AI 玩家已就绪，请在游戏窗口中进行操作。': ' KI-Spieler bereit. Bitte im Spielfenster operieren.',
  '游戏窗口已打开': 'Spielfenster geöffnet',
  '无法打开飞花令游戏窗口': 'Blumenworte-Spielfenster konnte nicht geöffnet werden',
  '无法打开谁是卧底游戏窗口': 'Untercover-Spielfenster konnte nicht geöffnet werden',
  '无法打开三国杀游戏窗口': 'Drei-Reiche-Spielfenster konnte nicht geöffnet werden',

  // ── Chat history labels ──
  '对话记录': 'Gesprächsaufzeichnung',
  '该对话没有记录工作目录': 'Dieses Gespräch hat keinen Arbeitsbereich',
  '导出对话记录(JSON)': 'Gespräch exportieren (JSON)',
  '导出对话记录(Markdown)': 'Gespräch exportieren (Markdown)',
  '已导出：': 'Exportiert:',
  '导出成功': 'Export erfolgreich',
  '导出失败：': 'Export fehlgeschlagen:',
  '创建时间：': 'Erstellt:',
  '更新时间：': 'Aktualisiert:',
  '工作目录：': 'Arbeitsbereich:',
  '用户': 'Benutzer',
  'AI': 'KI',
  '系统': 'System',

  // ── Context details ──
  '无可用工具': 'Keine Werkzeuge verfügbar',
  '优化失败，回退到精简启发式工具集': 'Optimierung fehlgeschlagen, Fallback auf heuristischen Werkzeugsatz',
  '优化失败': 'Optimierung fehlgeschlagen',
  '首条消息优化': 'Erste-Nachricht-Optimierung',
  '运行中重优化': 'Laufzeit-Neuoptimierung',
  '重优化完成': 'Neuoptimierung abgeschlossen',
  '检测到优化未执行，发送前自动补偿优化': 'Optimierung nicht ausgeführt, Auto-Kompensation vor Senden',
  '循环检测到优化未执行，自动补偿优化': 'Schleife erkannt: Optimierung nicht ausgeführt, Auto-Kompensation',
  '被禁用，需要重优化': 'ist deaktiviert, Neuoptimierung erforderlich',
  '不在当前集合，触发重优化': 'nicht in aktueller Menge, Neuoptimierung ausgelöst',
  '请先在设置中配置LLM API': 'Bitte zuerst LLM-API in Einstellungen konfigurieren',

  // ── Babe proactive message topics ──
  '关心用户今天过得怎么样': 'Fragen, wie der Tag des Benutzers war',
  '分享自己刚想到的一件小事': 'Eine kleine Sache teilen, die gerade eingefallen ist',
  '询问用户最近在忙什么': 'Fragen, womit der Benutzer beschäftigt ist',
  '表达想用户的心情': 'Ausdrücken, dass man den Benutzer vermisst',
  '聊聊最近看到的有趣事物': 'Über etwas Interessantes sprechen',
  '问问用户有没有好好吃饭': 'Fragen, ob der Benutzer gut gegessen hat',

  // ── Misc ──
  '读取 SKILL.md 失败': 'SKILL.md konnte nicht gelesen werden',
  '加载远程历史失败:': 'Remote-Verlauf konnte nicht geladen werden:',
  '找不到该对话': 'Gespräch nicht gefunden',
  '[多模态内容]': '[Multimodaler Inhalt]',
  ' - 图片': ' - Bild',
  '图片文件：': 'Bilddateien:',
  '(获取失败)': '(Abruf fehlgeschlagen)',
  '获取失败，请检查 Zen API Key 或网络': 'Fehlgeschlagen, Zen-API-Key oder Netzwerk prüfen',
  '获取失败，请检查 API URL/Key 或网络': 'Fehlgeschlagen, API-URL/Key oder Netzwerk prüfen',
  '共': 'Insgesamt',
  '个可用模型': ' verfügbare Modelle',
  '个可用模型（标 [免费] 的为免费模型）': ' verfügbare Modelle ([kostenlos] = kostenlose Modelle)',
  '[免费]': '[Kostenlos]',
  '加载失败': 'Laden fehlgeschlagen',

  // ── Added missing entries ──
  '命运之牌:': 'Tarot:',
  '尚未抽取': 'Noch nicht gezogen',
  '暂无技能...': 'Keine Skills...',
  '未命名会话': 'Unbenannte Sitzung',
  '(未选择工作区)': '(Kein Workspace ausgewählt)',
  '标准 Skill 导入': 'Standard Skill-Import',
  '【适用场景】': '[Anwendungsfälle]',
  '【执行说明】': '[Anweisungen]',
  '【约束】': '[Einschränkungen]',
  'JS脚本': 'JS-Skript',
  '选择标准 Skill 文件（SKILL.md）': 'Standard Skill-Datei auswählen (SKILL.md)',
  '【用户追加消息】': '[Benutzer hat Nachricht angehängt]',
  '**用户**:': '**Benutzer**:',
  '温柔、体贴、善解人意': 'Sanft, fürsorglich, verständnisvoll',
  '亲爱的': 'Liebling',
  '女生': 'Weiblich',
  '男生': 'Männlich',
  '人': 'Person',
  '深爱': 'Tief verliebt',
  '很喜欢': 'Mag sehr',
  '有好感': 'Hat Gefühle',
  '初步认识': 'Gerade kennengelernt',
  '刚认识': 'Neu bekannt',
  '[系统指令]': '[System-Anweisung]',

  // ── main.js IPC errors: Math/Calculation ──
  '除数不能为0': 'Divisor darf nicht 0 sein',
  '数字为空': 'Zahl ist leer',
  '无法解析数字': 'Zahl kann nicht geparst werden',
  '仅支持整数幂': 'Nur ganzzahlige Exponenten unterstützt',
  '指数过大': 'Exponent zu groß',
  '取模仅支持整数': 'Modulo unterstützt nur ganze Zahlen',
  '取模除数不能为0': 'Modulo-Divisor darf nicht 0 sein',
  '为保证精确计算，暂不支持 pi 等无理常数': 'Irrationale Konstanten wie pi werden für exakte Berechnung nicht unterstützt',
  '无法识别的符号': 'Unerkanntes Symbol',
  '括号不匹配': 'Klammerung fehlerhaft',
  '表达式为空': 'Ausdruck ist leer',
  '表达式不完整': 'Ausdruck ist unvollständig',
  '表达式不合法': 'Ungültiger Ausdruck',
  '不支持的运算符': 'Nicht unterstützter Operator',
  'values 至少需要2个整数': 'values erfordert mindestens 2 ganze Zahlen',
  '进制范围必须在2~36': 'Basis muss zwischen 2 und 36 liegen',
  'n 必须是非负整数': 'n muss eine nicht-negative ganze Zahl sein',
  'n 过大，当前限制为 2000': 'n ist zu groß, aktuelles Limit 2000',
  '复数除法分母为0': 'Komplexer Divisionsnenner ist 0',
  '复数幂仅支持整数指数': 'Komplexe Potenz unterstützt nur ganzzahlige Exponenten',
  '矩阵加减要求维度一致': 'Matrixaddition/sub erfordert gleiche Dimensionen',
  '矩阵乘法维度不匹配': 'Matrixmultiplikation-Dimensionsfehler',
  '行列式仅适用于方阵': 'Determinante nur für quadratische Matrizen',
  '逆矩阵仅适用于方阵': 'Inverse nur für quadratische Matrizen',
  '矩阵不可逆（奇异）': 'Matrix ist singulär (nicht invertierbar)',
  '叉积仅支持3维或7维向量': 'Kreuzprodukt nur für 3D- oder 7D-Vektoren',
  '全体实数': 'Alle reellen Zahlen',
  '无解': 'Keine Lösung',
  '方程组无解': 'System hat keine Lösung',
  '方程组有无穷多解': 'System hat unendlich viele Lösungen',
  '仅支持1~4次多项式': 'Nur Polynome vom Grad 1-4 unterstützt',
  'sigma 必须>0': 'sigma muss > 0 sein',
  'p 必须在[0,1]': 'p muss in [0,1] liegen',
  'lambda 必须>0': 'lambda muss > 0 sein',
  'uniform 要求 b > a': 'uniform erfordert b > a',
  'operation 必须是 permutation 或 combination': 'operation muss permutation oder combination sein',

  // ── main.js IPC errors: File search/read/write ──
  'paths 参数必须是非空数组': 'paths muss ein nicht-leeres Array sein',
  'pattern 参数必须是非空字符串': 'pattern muss ein nicht-leerer String sein',
  '终端不存在': 'Terminal existiert nicht',
  '无法截取屏幕': 'Bildschirm kann nicht erfasst werden',

  // ── main.js IPC errors: Image gen / timeout ──
  '执行超时': 'Ausführungs-Timeout',
  '请先配置生图API Key': 'Bitte zuerst Bildgenerierungs-API-Key konfigurieren',
  '已达到今日生图上限': 'Tageslimit für Bildgenerierung erreicht',
  '生图API未返回有效图片': 'Bild-API hat kein gültiges Bild zurückgegeben',
  '主窗口未就绪': 'Hauptfenster nicht bereit',
  '缺少URL': 'URL fehlt',

  // ── main.js IPC errors: TRNG ──
  '未配置TRNG串口': 'TRNG-Seriellport nicht konfiguriert',
  'serialport 模块未安装，请运行 npm install serialport': 'serialport-Modul nicht installiert, npm install serialport ausführen',
  'TRNG串口超时': 'TRNG-Seriellport-Timeout',
  'TRNG串口JSON解析失败': 'TRNG-Seriellport-JSON-Parsing fehlgeschlagen',
  'TRNG串口写入失败': 'TRNG-Seriellport-Schreiben fehlgeschlagen',
  'TRNG网络超时': 'TRNG-Netzwerk-Timeout',
  'TRNG网络数据解析失败': 'TRNG-Netzwerkdaten-Parsing fehlgeschlagen',
  'TRNG网络请求超时': 'TRNG-Netzwerkanfrage-Timeout',

  // ── main.js IPC errors: LLM/Zen ──
  '请先在设置中配置OpenCode Zen API Key和模型': 'Bitte zuerst OpenCode Zen API-Key und Modell in Einstellungen konfigurieren',
  '请先配置OpenCode Zen': 'Bitte zuerst OpenCode Zen konfigurieren',
  '请求超时（10s），请检查网络连接': 'Anfrage-Timeout (10s), Netzwerkverbindung prüfen',
  '请求超时（10s），请检查网络或 API URL': 'Anfrage-Timeout (10s), Netzwerk oder API-URL prüfen',

  // ── main.js IPC errors: File dialog titles ──
  '选择头像图片': 'Avatar-Bild auswählen',
  '选择文件': 'Datei auswählen',
  '保存文件': 'Datei speichern',
  '选择导出目录': 'Export-Verzeichnis auswählen',
  '用户取消': 'Benutzer abgebrochen',
  '选择 Code 模式工作区文件夹': 'Code-Modus-Arbeitsbereichsordner auswählen',

  // ── main.js IPC errors: Playwright ──
  '无法启动指定的浏览器:': 'Angegebenen Browser kann nicht gestartet werden:',
  '内置 Chromium 启动失败:': 'Integriertes Chromium-Starten fehlgeschlagen:',
  'URL 参数缺失或无效': 'URL-Parameter fehlt oder ist ungültig',

  // ── main.js IPC errors: File format / QR code ──
  '需要安装adm-zip包来处理此文件格式': 'adm-zip-Paket für dieses Dateiformat erforderlich',
  '(PDF文本提取有限，建议使用OCR)': '(PDF-Textextraktion begrenzt, OCR empfohlen)',
  '不支持的文件格式': 'Nicht unterstütztes Dateiformat',
  '技能不存在': 'Fertigkeit existiert nicht',
  '无法加载图片': 'Bild kann nicht geladen werden',
  '未识别到二维码': 'Kein QR-Code erkannt',

  // ── main.js IPC errors: Network tools ──
  '未设置工作区路径': 'Arbeitsbereichspfad nicht festgelegt',
  '请使用重定向后的最终URL': 'Bitte die finale weitergeleitete URL verwenden',
  '缺少url': 'url fehlt',
  '缺少path': 'path fehlt',
  '无法获取证书': 'Zertifikat kann nicht abgerufen werden',
  '连接超时': 'Verbindungs-Timeout',
  '无效端口范围': 'Ungültiger Portbereich',
  '端口范围过大(最大1024个)': 'Portbereich zu groß (max 1024)',

  // ── main.js IPC errors: Game ──
  '你是三国杀AI玩家': 'Du bist der Drei-Reiche-KI-Spieler',

  // ── main.js IPC errors: MCP ──
  '同名服务器已存在': 'Server mit gleichem Namen existiert bereits',
  '服务器不存在': 'Server existiert nicht',
  '服务器未连接': 'Server ist nicht verbunden',

  // ── main.js IPC errors: Serial messages ──
  '已打开': 'geöffnet',
  '未打开': 'ist nicht geöffnet',
  '已关闭': 'geschlossen',

  // ── main.js IPC errors: Office tools ──
  '缺少pathOrDir参数': 'pathOrDir-Parameter fehlt',
  '路径不存在:': 'Pfad existiert nicht:',
  '仅支持 .docx/.odt': 'Nur .docx/.odt unterstützt',
  '不是可识别的Word文档目录': 'Kein erkennbares Word-Dokumentverzeichnis',
  '文件不存在:': 'Datei existiert nicht:',
  '已解压到': 'Entpackt nach',
  '目录不存在:': 'Verzeichnis existiert nicht:',
  '已打包为': 'Verpackt als',
  '处文字': 'Textstellen',
  '缺少有效updates': 'Gültige Updates fehlen',

  // ── main.js IPC errors: Email mode ──
  '跳过': 'Übersprungen',
  '只发模式，无需轮询': 'Nur-Senden-Modus, kein Polling nötig',
  '邮件模式为只收，无法发送审批请求，已拒绝': 'E-Mail-Modus ist nur-Empfang, Genehmigungsanfrage abgelehnt',
  '邮件模式为只发，无法接收审批回复，已拒绝': 'E-Mail-Modus ist nur-Senden, Genehmigungsantwort abgelehnt',
  '邮件模式为只收，无法发送对话摘要': 'E-Mail-Modus ist nur-Empfang, Gesprächszusammenfassung kann nicht gesendet werden',

  // ── agent.js tool internal strings ──
  '未命名技能': 'Unbenannte Fertigkeit',
  '无描述': 'Keine Beschreibung',

  // ── app.js dynamic strings ──
  '请先填写 URL 和 Key': 'Bitte zuerst URL und Key ausfüllen',
  '包括用户消息': 'einschließlich Benutzernachricht',
  '工具调用': 'Werkzeugaufrufe',
  'AI回复': 'KI-Antwort',

  // ── CIPYP-CAD ──
  'CIPYP-CAD 工程已保存到：': 'CIPYP-CAD-Projekt gespeichert unter:',
  'DXF 已导出到：': 'DXF exportiert unter:',
  '可用 AutoCAD/FreeCAD/QCAD 等打开': 'Kann mit AutoCAD/FreeCAD/QCAD usw. geöffnet werden',
  '已导出到：': 'exportiert unter:',
  '需要 path 参数指定工程文件路径': 'path-Parameter erforderlich um Projektdatei anzugeben',
  '未设置工作区路径，且未提供 path 参数': 'Arbeitsbereichspfad nicht gesetzt und kein path-Parameter angegeben',
  'CIPYP-CAD 窗口已打开': 'CIPYP-CAD-Fenster geöffnet',
  'CIPYP-CAD 窗口已关闭': 'CIPYP-CAD-Fenster geschlossen',
  'CIPYP-CAD 命令已执行': 'CIPYP-CAD-Befehl ausgeführt',
  '工程文件格式无效': 'Ungültiges Projektdateiformat',
  'CAD 引擎未就绪': 'CAD-Engine nicht bereit'
}

};

i18nRegister('de', DE_DICT);
