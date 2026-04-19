// ==UserScript==
// @name         Spreadsheet Viewer
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Render local and remote CSV/TSV files as an editable spreadsheet with autosave and export support.
// @description:en Render local and remote CSV/TSV files as an editable spreadsheet with autosave and export support.
// @description:de Lokale und entfernte CSV/TSV-Dateien als bearbeitbare Tabellenkalkulation mit Autosave und Export darstellen.
// @author       artsy-compute
// @license      MIT
// @match        *://*/*.csv
// @match        *://*/*.tsv
// @include      file://*/*.csv
// @include      file://*/*.tsv
// @exclude      https://github.com/*
// @exclude      http://github.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    const APP_STYLE_ID = 'userscript-spreadsheet-style';
    const STORAGE_KEY_PREFIX = 'spreadsheetViewer_sheet:';
    const SAVE_STATUS_TTL_MS = 1800;
    const AUTOSAVE_DELAY_MS = 500;
    const DELIMITER_NAMES = {
        ',': 'CSV',
        '\t': 'TSV',
        ';': 'Semicolon CSV'
    };

    const state = {
        delimiter: ',',
        rows: [['']],
        originalRows: [['']],
        selectedRow: 0,
        selectedCol: 0,
        editor: null,
        saveTimer: null,
        saveStatus: 'ready',
        saveMessage: '',
        saveMessageTimer: null,
        sheetName: 'sheet',
        originalFileName: 'sheet.csv',
        fileExtension: 'csv',
        root: null,
        titleNode: null,
        summaryNode: null,
        formulaLabelNode: null,
        formulaInputNode: null,
        gridNode: null,
        saveStatusNode: null,
        sourceIndicatorNode: null
    };

    function removeExistingStyleElement(id) {
        const existingStyle = document.getElementById(id);
        if (existingStyle) {
            existingStyle.remove();
        }
    }

    function addStyleElement(id, css) {
        removeExistingStyleElement(id);
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function applyBaseStyles() {
        addStyleElement(APP_STYLE_ID, `
            :root {
                --sheet-bg: linear-gradient(180deg, #f5f1e8 0%, #f8f5ef 44%, #f3efe6 100%);
                --sheet-panel: rgba(255, 252, 245, 0.92);
                --sheet-panel-strong: rgba(255, 249, 238, 0.98);
                --sheet-ink: #2a2219;
                --sheet-muted: #6d6456;
                --sheet-accent: #1f5f8b;
                --sheet-accent-soft: rgba(31, 95, 139, 0.12);
                --sheet-accent-strong: #0c3e60;
                --sheet-line: rgba(74, 60, 45, 0.16);
                --sheet-line-strong: rgba(74, 60, 45, 0.28);
                --sheet-selected: rgba(255, 191, 71, 0.28);
                --sheet-header: rgba(255, 243, 219, 0.88);
                --sheet-header-strong: rgba(255, 233, 182, 0.95);
                --sheet-danger: #8a2f1f;
                --sheet-shadow: 0 22px 50px rgba(58, 45, 27, 0.13);
            }

            @media (prefers-color-scheme: dark) {
                :root {
                    --sheet-bg: linear-gradient(180deg, #15181d 0%, #1b2028 52%, #161a20 100%);
                    --sheet-panel: rgba(31, 37, 46, 0.94);
                    --sheet-panel-strong: rgba(36, 43, 52, 0.98);
                    --sheet-ink: #edf0f4;
                    --sheet-muted: #a8b1be;
                    --sheet-accent: #8ac6ff;
                    --sheet-accent-soft: rgba(138, 198, 255, 0.16);
                    --sheet-accent-strong: #c6e5ff;
                    --sheet-line: rgba(203, 216, 229, 0.11);
                    --sheet-line-strong: rgba(203, 216, 229, 0.22);
                    --sheet-selected: rgba(255, 191, 71, 0.18);
                    --sheet-header: rgba(56, 64, 77, 0.92);
                    --sheet-header-strong: rgba(74, 82, 97, 0.96);
                    --sheet-danger: #ff9380;
                    --sheet-shadow: 0 24px 56px rgba(0, 0, 0, 0.28);
                }
            }

            html, body {
                margin: 0;
                min-height: 100%;
                background: var(--sheet-bg);
                color: var(--sheet-ink);
                font-family: "Aptos", "IBM Plex Sans", "Segoe UI", sans-serif;
            }

            body {
                padding: 28px 20px 40px;
                box-sizing: border-box;
            }

            .sheet-app {
                max-width: 1400px;
                margin: 0 auto;
                display: grid;
                gap: 16px;
            }

            .sheet-topbar,
            .sheet-formula,
            .sheet-grid-shell {
                background: var(--sheet-panel);
                border: 1px solid var(--sheet-line);
                border-radius: 18px;
                box-shadow: var(--sheet-shadow);
                backdrop-filter: blur(10px);
            }

            .sheet-topbar {
                padding: 20px 22px 18px;
                display: grid;
                gap: 14px;
            }

            .sheet-topline {
                display: flex;
                justify-content: space-between;
                gap: 20px;
                align-items: flex-start;
                flex-wrap: wrap;
            }

            .sheet-title-wrap {
                display: grid;
                gap: 6px;
            }

            .sheet-kicker {
                font-size: 0.76rem;
                letter-spacing: 0.16em;
                text-transform: uppercase;
                color: var(--sheet-muted);
            }

            .sheet-title {
                margin: 0;
                font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
                font-size: clamp(1.8rem, 2.7vw, 2.7rem);
                line-height: 1.05;
                letter-spacing: -0.03em;
            }

            .sheet-summary {
                margin: 0;
                font-size: 0.98rem;
                color: var(--sheet-muted);
            }

            .sheet-source-indicator {
                align-self: start;
                padding: 8px 12px;
                border-radius: 999px;
                background: var(--sheet-accent-soft);
                color: var(--sheet-accent-strong);
                font-size: 0.87rem;
                font-weight: 600;
                white-space: nowrap;
            }

            .sheet-toolbar {
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
            }

            .sheet-button,
            .sheet-danger-button {
                appearance: none;
                border: 1px solid var(--sheet-line-strong);
                border-radius: 999px;
                background: var(--sheet-panel-strong);
                color: var(--sheet-ink);
                cursor: pointer;
                font: inherit;
                font-size: 0.93rem;
                font-weight: 600;
                padding: 10px 14px;
                transition: transform 0.14s ease, background-color 0.14s ease, border-color 0.14s ease;
            }

            .sheet-button:hover,
            .sheet-button:focus-visible,
            .sheet-danger-button:hover,
            .sheet-danger-button:focus-visible {
                transform: translateY(-1px);
                border-color: var(--sheet-accent);
                background: var(--sheet-accent-soft);
                outline: none;
            }

            .sheet-danger-button {
                color: var(--sheet-danger);
            }

            .sheet-formula {
                padding: 14px 18px;
                display: grid;
                gap: 10px;
            }

            .sheet-formula-header {
                display: flex;
                justify-content: space-between;
                gap: 16px;
                align-items: center;
                flex-wrap: wrap;
            }

            .sheet-formula-label {
                font-size: 0.9rem;
                font-weight: 700;
                letter-spacing: 0.04em;
                text-transform: uppercase;
                color: var(--sheet-muted);
            }

            .sheet-save-status {
                font-size: 0.88rem;
                color: var(--sheet-muted);
            }

            .sheet-formula-input {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid var(--sheet-line-strong);
                border-radius: 12px;
                padding: 12px 14px;
                background: var(--sheet-panel-strong);
                color: var(--sheet-ink);
                font: inherit;
                font-size: 0.98rem;
            }

            .sheet-formula-input:focus {
                outline: 2px solid var(--sheet-accent-soft);
                border-color: var(--sheet-accent);
            }

            .sheet-grid-shell {
                overflow: hidden;
            }

            .sheet-grid-scroll {
                overflow: auto;
                max-height: calc(100vh - 290px);
                border-radius: 18px;
            }

            .sheet-grid {
                width: max-content;
                min-width: 100%;
                border-collapse: separate;
                border-spacing: 0;
                table-layout: fixed;
            }

            .sheet-grid th,
            .sheet-grid td {
                border-right: 1px solid var(--sheet-line);
                border-bottom: 1px solid var(--sheet-line);
            }

            .sheet-grid thead th {
                position: sticky;
                top: 0;
                z-index: 3;
                background: var(--sheet-header);
                font-size: 0.88rem;
                color: var(--sheet-muted);
                font-weight: 700;
                text-align: center;
                min-width: 130px;
            }

            .sheet-grid thead th:first-child {
                left: 0;
                z-index: 4;
                min-width: 56px;
            }

            .sheet-row-header {
                position: sticky;
                left: 0;
                z-index: 2;
                background: var(--sheet-header);
                color: var(--sheet-muted);
                font-size: 0.88rem;
                font-weight: 700;
                text-align: center;
                min-width: 56px;
            }

            .sheet-grid thead th:first-child,
            .sheet-row-header {
                background: linear-gradient(180deg, var(--sheet-header-strong) 0%, var(--sheet-header) 100%);
            }

            .sheet-cell {
                min-width: 130px;
                max-width: 320px;
                padding: 0;
                background: transparent;
                position: relative;
            }

            .sheet-cell-button {
                appearance: none;
                width: 100%;
                min-height: 40px;
                padding: 9px 11px;
                border: none;
                background: transparent;
                color: inherit;
                text-align: left;
                font: inherit;
                cursor: cell;
                white-space: pre-wrap;
                word-break: break-word;
            }

            .sheet-cell-button:focus {
                outline: none;
            }

            .sheet-cell-selected {
                background: var(--sheet-selected);
                box-shadow: inset 0 0 0 2px var(--sheet-accent);
            }

            .sheet-cell-input {
                width: calc(100% - 8px);
                margin: 4px;
                min-height: 32px;
                border: 1px solid var(--sheet-accent);
                border-radius: 8px;
                padding: 7px 8px;
                box-sizing: border-box;
                background: var(--sheet-panel-strong);
                color: var(--sheet-ink);
                font: inherit;
            }

            .sheet-empty-hint {
                padding: 36px 26px;
                text-align: center;
                color: var(--sheet-muted);
            }

            .sheet-grid tr:first-child th,
            .sheet-grid tr:first-child td {
                border-top: 1px solid var(--sheet-line);
            }

            .sheet-grid th:first-child,
            .sheet-grid td:first-child {
                border-left: 1px solid var(--sheet-line);
            }

            @media (max-width: 900px) {
                body {
                    padding: 18px 10px 28px;
                }

                .sheet-topbar,
                .sheet-formula {
                    border-radius: 14px;
                }

                .sheet-grid-scroll {
                    max-height: calc(100vh - 250px);
                }

                .sheet-grid thead th,
                .sheet-cell {
                    min-width: 116px;
                }
            }
        `);
    }

    function cloneRows(rows) {
        return rows.map((row) => row.slice());
    }

    function getFileNameFromLocation() {
        const pathParts = location.pathname.split('/');
        const lastPart = pathParts[pathParts.length - 1] || 'sheet.csv';

        try {
            return decodeURIComponent(lastPart);
        } catch {
            return lastPart;
        }
    }

    function getExtensionFromFileName(fileName) {
        const match = /\.([^.]+)$/.exec(fileName);
        return match ? match[1].toLowerCase() : 'csv';
    }

    function getStorageKey() {
        return `${STORAGE_KEY_PREFIX}${location.href}`;
    }

    function getColumnCount(rows = state.rows) {
        return Math.max(1, ...rows.map((row) => row.length));
    }

    function ensureGridShape(rows) {
        const columnCount = getColumnCount(rows);
        const safeRows = rows.length ? rows : [['']];

        safeRows.forEach((row) => {
            while (row.length < columnCount) {
                row.push('');
            }
        });

        return safeRows;
    }

    function getCellValue(rowIndex, colIndex) {
        const row = state.rows[rowIndex];
        return row && typeof row[colIndex] === 'string' ? row[colIndex] : '';
    }

    function setCellValue(rowIndex, colIndex, nextValue, renderMode = 'cell') {
        ensureCellExists(rowIndex, colIndex);
        state.rows[rowIndex][colIndex] = nextValue;
        scheduleAutosave();

        if (renderMode === 'grid') {
            renderGrid();
        } else {
            updateCellDisplay(rowIndex, colIndex);
            updateSummary();
        }
    }

    function ensureCellExists(rowIndex, colIndex) {
        while (state.rows.length <= rowIndex) {
            state.rows.push(Array.from({ length: getColumnCount() }, () => ''));
        }

        const requiredColumns = Math.max(getColumnCount(), colIndex + 1);
        state.rows = ensureGridShape(state.rows);
        state.rows.forEach((row) => {
            while (row.length < requiredColumns) {
                row.push('');
            }
        });
    }

    function clampSelection() {
        const rowCount = Math.max(1, state.rows.length);
        const colCount = getColumnCount();

        state.selectedRow = Math.min(Math.max(0, state.selectedRow), rowCount - 1);
        state.selectedCol = Math.min(Math.max(0, state.selectedCol), colCount - 1);
    }

    function getColumnLabel(index) {
        let value = index + 1;
        let label = '';

        while (value > 0) {
            const remainder = (value - 1) % 26;
            label = String.fromCharCode(65 + remainder) + label;
            value = Math.floor((value - 1) / 26);
        }

        return label;
    }

    function getSelectedCellReference() {
        return `${getColumnLabel(state.selectedCol)}${state.selectedRow + 1}`;
    }

    function getRawDocumentText() {
        if (!document.body) {
            return '';
        }

        if (document.body.children.length === 1 && document.body.firstChild && document.body.firstChild.tagName === 'PRE') {
            return document.body.firstChild.innerText;
        }

        return document.body.innerText || document.body.textContent || '';
    }

    function detectDelimiter(text, extension) {
        if (extension === 'tsv' || extension === 'tab') {
            return '\t';
        }

        const candidates = [',', '\t', ';'];
        const sampleLines = text.split(/\r\n|\n|\r/).filter(Boolean).slice(0, 8);

        if (!sampleLines.length) {
            return ',';
        }

        let bestDelimiter = ',';
        let bestScore = -1;

        candidates.forEach((candidate) => {
            let score = 0;

            sampleLines.forEach((line) => {
                score += countDelimiterOutsideQuotes(line, candidate);
            });

            if (score > bestScore) {
                bestScore = score;
                bestDelimiter = candidate;
            }
        });

        return bestDelimiter;
    }

    function countDelimiterOutsideQuotes(line, delimiter) {
        let count = 0;
        let inQuotes = false;

        for (let index = 0; index < line.length; index += 1) {
            const char = line[index];
            const nextChar = line[index + 1];

            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    index += 1;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }

            if (!inQuotes && char === delimiter) {
                count += 1;
            }
        }

        return count;
    }

    function parseDelimitedText(text, delimiter) {
        if (!text) {
            return [['']];
        }

        const rows = [];
        let currentRow = [];
        let currentCell = '';
        let inQuotes = false;

        for (let index = 0; index < text.length; index += 1) {
            const char = text[index];
            const nextChar = text[index + 1];

            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    currentCell += '"';
                    index += 1;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }

            if (!inQuotes && char === delimiter) {
                currentRow.push(currentCell);
                currentCell = '';
                continue;
            }

            if (!inQuotes && (char === '\n' || char === '\r')) {
                if (char === '\r' && nextChar === '\n') {
                    index += 1;
                }

                currentRow.push(currentCell);
                rows.push(currentRow);
                currentRow = [];
                currentCell = '';
                continue;
            }

            currentCell += char;
        }

        currentRow.push(currentCell);
        rows.push(currentRow);

        if (rows.length > 1) {
            const lastRow = rows[rows.length - 1];
            const isTrailingEmptyRow = lastRow.length === 1 && lastRow[0] === '' && /(?:\r\n|\n|\r)$/.test(text);

            if (isTrailingEmptyRow) {
                rows.pop();
            }
        }

        return ensureGridShape(rows);
    }

    function escapeDelimitedCell(value, delimiter) {
        const stringValue = String(value ?? '');
        const shouldQuote = stringValue.includes('"') ||
            stringValue.includes(delimiter) ||
            stringValue.includes('\n') ||
            stringValue.includes('\r') ||
            /^\s|\s$/.test(stringValue);

        if (!shouldQuote) {
            return stringValue;
        }

        return `"${stringValue.replace(/"/g, '""')}"`;
    }

    function serializeRows(rows, delimiter) {
        return rows
            .map((row) => row.map((value) => escapeDelimitedCell(value, delimiter)).join(delimiter))
            .join('\r\n');
    }

    function parseClipboardMatrix(text) {
        if (!text) {
            return [['']];
        }

        const preferredDelimiter = text.includes('\t') ? '\t' : detectDelimiter(text, state.fileExtension);
        return parseDelimitedText(text, preferredDelimiter);
    }

    function downloadCurrentSheet() {
        const delimiter = state.delimiter;
        const fileExtension = delimiter === '\t' ? 'tsv' : 'csv';
        const downloadName = state.sheetName ? `${state.sheetName}.${fileExtension}` : `sheet.${fileExtension}`;
        const mediaType = delimiter === '\t'
            ? 'text/tab-separated-values;charset=utf-8'
            : 'text/csv;charset=utf-8';
        const blob = new Blob([serializeRows(state.rows, delimiter)], { type: mediaType });
        const downloadUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');

        anchor.href = downloadUrl;
        anchor.download = downloadName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
        flashSaveMessage(`Downloaded ${downloadName}.`);
    }

    function persistSheet() {
        const payload = {
            delimiter: state.delimiter,
            rows: state.rows,
            savedAt: new Date().toISOString()
        };

        state.saveTimer = null;
        GM_setValue(getStorageKey(), JSON.stringify(payload));
        state.saveStatus = 'saved';
        state.saveMessage = 'Autosaved locally';
        updateSummary();
        restartSaveMessageTimer();
    }

    function restartSaveMessageTimer() {
        if (state.saveMessageTimer) {
            clearTimeout(state.saveMessageTimer);
        }

        state.saveMessageTimer = setTimeout(() => {
            state.saveMessage = '';
            updateSummary();
        }, SAVE_STATUS_TTL_MS);
    }

    function flashSaveMessage(message) {
        state.saveMessage = message;
        updateSummary();
        restartSaveMessageTimer();
    }

    function scheduleAutosave() {
        state.saveStatus = 'dirty';
        if (state.saveTimer) {
            clearTimeout(state.saveTimer);
        }

        state.saveTimer = setTimeout(() => {
            persistSheet();
        }, AUTOSAVE_DELAY_MS);

        updateSummary();
    }

    function clearAutosave() {
        if (state.saveTimer) {
            clearTimeout(state.saveTimer);
            state.saveTimer = null;
        }

        GM_deleteValue(getStorageKey());
        state.saveStatus = 'ready';
        flashSaveMessage('Local autosave cleared.');
    }

    function loadPersistedSheet() {
        const rawValue = GM_getValue(getStorageKey(), '');

        if (!rawValue) {
            return false;
        }

        try {
            const parsed = JSON.parse(rawValue);
            if (!parsed || !Array.isArray(parsed.rows)) {
                return false;
            }

            state.rows = ensureGridShape(parsed.rows.map((row) =>
                Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : ['']
            ));

            if (parsed.delimiter && typeof parsed.delimiter === 'string') {
                state.delimiter = parsed.delimiter;
            }

            state.saveStatus = 'saved';
            state.saveMessage = 'Restored local edits';
            restartSaveMessageTimer();
            return true;
        } catch {
            return false;
        }
    }

    function replaceSheetRows(nextRows, shouldRender = true) {
        state.rows = ensureGridShape(nextRows.map((row) => row.map((cell) => String(cell ?? ''))));
        clampSelection();

        if (shouldRender) {
            renderGrid();
        } else {
            updateSummary();
        }
    }

    function resetToOriginalSheet() {
        state.editor = null;
        replaceSheetRows(cloneRows(state.originalRows));
        clearAutosave();
    }

    function insertRow(afterIndex) {
        const newRow = Array.from({ length: getColumnCount() }, () => '');
        state.rows.splice(afterIndex + 1, 0, newRow);
        state.selectedRow = afterIndex + 1;
        state.selectedCol = 0;
        scheduleAutosave();
        renderGrid();
    }

    function insertColumn(afterIndex) {
        state.rows.forEach((row) => {
            row.splice(afterIndex + 1, 0, '');
        });

        state.selectedCol = afterIndex + 1;
        scheduleAutosave();
        renderGrid();
    }

    function deleteSelectedRow() {
        if (state.rows.length === 1) {
            state.rows[0] = Array.from({ length: getColumnCount() }, () => '');
        } else {
            state.rows.splice(state.selectedRow, 1);
        }

        clampSelection();
        scheduleAutosave();
        renderGrid();
    }

    function deleteSelectedColumn() {
        const columnCount = getColumnCount();

        if (columnCount === 1) {
            state.rows.forEach((row) => {
                row[0] = '';
            });
        } else {
            state.rows.forEach((row) => {
                row.splice(state.selectedCol, 1);
            });
        }

        clampSelection();
        scheduleAutosave();
        renderGrid();
    }

    function updateCellDisplay(rowIndex, colIndex) {
        const cellNode = state.gridNode.querySelector(`[data-cell-display="1"][data-row="${rowIndex}"][data-col="${colIndex}"]`);
        if (cellNode) {
            cellNode.textContent = getCellValue(rowIndex, colIndex);
        }
    }

    function focusSelectedCell() {
        const selectedButton = state.gridNode.querySelector(`[data-cell-button="1"][data-row="${state.selectedRow}"][data-col="${state.selectedCol}"]`);
        if (selectedButton) {
            selectedButton.focus({ preventScroll: true });
            selectedButton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }

    function selectCell(rowIndex, colIndex, shouldFocus = true) {
        state.selectedRow = rowIndex;
        state.selectedCol = colIndex;
        clampSelection();
        state.editor = null;
        renderGrid();

        if (shouldFocus) {
            focusSelectedCell();
        }
    }

    function beginEditingCell(rowIndex, colIndex, seedValue) {
        state.selectedRow = rowIndex;
        state.selectedCol = colIndex;
        clampSelection();
        state.editor = {
            row: state.selectedRow,
            col: state.selectedCol,
            value: typeof seedValue === 'string' ? seedValue : getCellValue(state.selectedRow, state.selectedCol)
        };
        renderGrid();
    }

    function commitEditor(moveDirection) {
        if (!state.editor) {
            return;
        }

        const { row, col, value } = state.editor;
        state.editor = null;
        setCellValue(row, col, value, 'grid');

        if (moveDirection === 'down') {
            selectCell(Math.min(state.rows.length - 1, row + 1), col);
        } else if (moveDirection === 'right') {
            selectCell(row, Math.min(getColumnCount() - 1, col + 1));
        } else if (moveDirection === 'left') {
            selectCell(row, Math.max(0, col - 1));
        } else {
            selectCell(row, col);
        }
    }

    function cancelEditor() {
        if (!state.editor) {
            return;
        }

        const { row, col } = state.editor;
        state.editor = null;
        selectCell(row, col);
    }

    function pasteMatrixAtSelection(matrix) {
        const normalizedMatrix = ensureGridShape(matrix);
        const targetRowCount = state.selectedRow + normalizedMatrix.length;
        const targetColCount = state.selectedCol + getColumnCount(normalizedMatrix);

        while (state.rows.length < targetRowCount) {
            state.rows.push(Array.from({ length: getColumnCount() }, () => ''));
        }

        state.rows = ensureGridShape(state.rows);
        if (getColumnCount() < targetColCount) {
            state.rows.forEach((row) => {
                while (row.length < targetColCount) {
                    row.push('');
                }
            });
        }

        normalizedMatrix.forEach((row, rowOffset) => {
            row.forEach((value, colOffset) => {
                state.rows[state.selectedRow + rowOffset][state.selectedCol + colOffset] = value;
            });
        });

        scheduleAutosave();
        renderGrid();
    }

    function updateSummary() {
        const rowCount = state.rows.length;
        const columnCount = getColumnCount();
        const delimiterName = DELIMITER_NAMES[state.delimiter] || `Delimiter ${JSON.stringify(state.delimiter)}`;
        const selectedValue = getCellValue(state.selectedRow, state.selectedCol);
        const nextFormulaValue = state.editor ? state.editor.value : selectedValue;

        state.titleNode.textContent = state.sheetName;
        state.summaryNode.textContent = `${rowCount} rows · ${columnCount} columns · ${delimiterName} · Selected ${getSelectedCellReference()} (${selectedValue.length} chars)`;
        state.formulaLabelNode.textContent = `Cell ${getSelectedCellReference()}`;

        if (document.activeElement !== state.formulaInputNode || state.formulaInputNode.value !== nextFormulaValue) {
            state.formulaInputNode.value = nextFormulaValue;
        }

        if (state.saveStatus === 'dirty') {
            state.saveStatusNode.textContent = 'Saving local edits…';
        } else if (state.saveMessage) {
            state.saveStatusNode.textContent = state.saveMessage;
        } else if (state.saveStatus === 'saved') {
            state.saveStatusNode.textContent = 'Local autosave is current.';
        } else {
            state.saveStatusNode.textContent = 'No local overrides yet.';
        }

        state.sourceIndicatorNode.textContent = state.fileExtension === 'tsv' ? 'TSV sheet' : 'CSV sheet';
    }

    function attachEditorHandlers() {
        const editorInput = state.gridNode.querySelector('[data-cell-editor="1"]');
        if (!editorInput) {
            return;
        }

        editorInput.addEventListener('input', (event) => {
            if (state.editor) {
                state.editor.value = event.target.value;
                state.formulaInputNode.value = state.editor.value;
                updateSummary();
            }
        });

        editorInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commitEditor('down');
            } else if (event.key === 'Tab') {
                event.preventDefault();
                commitEditor(event.shiftKey ? 'left' : 'right');
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelEditor();
            }
        });

        editorInput.addEventListener('blur', () => {
            if (state.editor) {
                commitEditor();
            }
        });

        editorInput.focus();
        editorInput.select();
    }

    function renderGrid() {
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        const cornerHeader = document.createElement('th');
        const tbody = document.createElement('tbody');
        const columnCount = getColumnCount();

        table.className = 'sheet-grid';
        cornerHeader.textContent = '#';
        headerRow.appendChild(cornerHeader);

        for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
            const th = document.createElement('th');
            th.textContent = getColumnLabel(colIndex);
            headerRow.appendChild(th);
        }

        thead.appendChild(headerRow);
        table.appendChild(thead);

        state.rows.forEach((row, rowIndex) => {
            const tr = document.createElement('tr');
            const rowHeader = document.createElement('th');
            rowHeader.className = 'sheet-row-header';
            rowHeader.textContent = String(rowIndex + 1);
            tr.appendChild(rowHeader);

            for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
                const td = document.createElement('td');
                const isSelected = rowIndex === state.selectedRow && colIndex === state.selectedCol;
                const isEditing = state.editor && rowIndex === state.editor.row && colIndex === state.editor.col;

                td.className = `sheet-cell${isSelected ? ' sheet-cell-selected' : ''}`;

                if (isEditing) {
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'sheet-cell-input';
                    input.value = state.editor.value;
                    input.setAttribute('data-cell-editor', '1');
                    td.appendChild(input);
                } else {
                    const button = document.createElement('button');
                    const display = document.createElement('span');

                    button.type = 'button';
                    button.className = 'sheet-cell-button';
                    button.setAttribute('data-cell-button', '1');
                    button.setAttribute('data-row', String(rowIndex));
                    button.setAttribute('data-col', String(colIndex));
                    button.setAttribute('aria-label', `Cell ${getColumnLabel(colIndex)}${rowIndex + 1}`);

                    display.setAttribute('data-cell-display', '1');
                    display.setAttribute('data-row', String(rowIndex));
                    display.setAttribute('data-col', String(colIndex));
                    display.textContent = row[colIndex] || '';

                    button.appendChild(display);
                    td.appendChild(button);
                }

                tr.appendChild(td);
            }

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        state.gridNode.replaceChildren(table);
        updateSummary();
        attachEditorHandlers();
    }

    function handleGridClick(event) {
        const button = event.target.closest('[data-cell-button="1"]');
        if (!button) {
            return;
        }

        if (state.editor) {
            commitEditor();
        }

        const rowIndex = Number(button.getAttribute('data-row'));
        const colIndex = Number(button.getAttribute('data-col'));
        selectCell(rowIndex, colIndex);
    }

    function handleGridDoubleClick(event) {
        const button = event.target.closest('[data-cell-button="1"]');
        if (!button) {
            return;
        }

        const rowIndex = Number(button.getAttribute('data-row'));
        const colIndex = Number(button.getAttribute('data-col'));
        beginEditingCell(rowIndex, colIndex);
    }

    function handleFormulaInput(event) {
        const nextValue = event.target.value;

        if (state.editor &&
            state.editor.row === state.selectedRow &&
            state.editor.col === state.selectedCol) {
            state.editor.value = nextValue;
            const editorNode = state.gridNode.querySelector('[data-cell-editor="1"]');
            if (editorNode && editorNode.value !== nextValue) {
                editorNode.value = nextValue;
            }
            updateSummary();
            return;
        }

        setCellValue(state.selectedRow, state.selectedCol, nextValue, 'cell');
    }

    function handleFormulaKeyDown(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            if (state.editor) {
                commitEditor('down');
            } else {
                selectCell(Math.min(state.rows.length - 1, state.selectedRow + 1), state.selectedCol);
            }
        } else if (event.key === 'Escape' && state.editor) {
            event.preventDefault();
            cancelEditor();
        }
    }

    function handleKeyboardNavigation(event) {
        const isElementTarget = event.target && typeof event.target.matches === 'function';
        const isTypingField = event.target === state.formulaInputNode ||
            (isElementTarget && event.target.matches('[data-cell-editor="1"]'));

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (state.editor) {
                commitEditor();
            }
            downloadCurrentSheet();
            return;
        }

        if (isTypingField) {
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectCell(Math.max(0, state.selectedRow - 1), state.selectedCol);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectCell(Math.min(state.rows.length - 1, state.selectedRow + 1), state.selectedCol);
        } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            selectCell(state.selectedRow, Math.max(0, state.selectedCol - 1));
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            selectCell(state.selectedRow, Math.min(getColumnCount() - 1, state.selectedCol + 1));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            selectCell(Math.min(state.rows.length - 1, state.selectedRow + 1), state.selectedCol);
        } else if (event.key === 'Tab') {
            event.preventDefault();
            selectCell(state.selectedRow, Math.min(getColumnCount() - 1, state.selectedCol + (event.shiftKey ? -1 : 1)));
        } else if (event.key === 'F2') {
            event.preventDefault();
            beginEditingCell(state.selectedRow, state.selectedCol);
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            setCellValue(state.selectedRow, state.selectedCol, '', 'cell');
        } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            beginEditingCell(state.selectedRow, state.selectedCol, event.key);
        }
    }

    function handlePaste(event) {
        const isElementTarget = event.target && typeof event.target.matches === 'function';
        const isTypingField = event.target === state.formulaInputNode ||
            (isElementTarget && event.target.matches('[data-cell-editor="1"]'));

        if (isTypingField) {
            return;
        }

        const clipboardText = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (!clipboardText) {
            return;
        }

        event.preventDefault();
        pasteMatrixAtSelection(parseClipboardMatrix(clipboardText));
    }

    function createButton(label, className, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    function buildAppShell() {
        const app = document.createElement('div');
        const topbar = document.createElement('section');
        const topLine = document.createElement('div');
        const titleWrap = document.createElement('div');
        const kicker = document.createElement('div');
        const title = document.createElement('h1');
        const summary = document.createElement('p');
        const sourceIndicator = document.createElement('div');
        const toolbar = document.createElement('div');
        const formulaSection = document.createElement('section');
        const formulaHeader = document.createElement('div');
        const formulaLabel = document.createElement('div');
        const saveStatus = document.createElement('div');
        const formulaInput = document.createElement('input');
        const gridShell = document.createElement('section');
        const gridScroll = document.createElement('div');
        const grid = document.createElement('div');

        app.className = 'sheet-app';
        topbar.className = 'sheet-topbar';
        topLine.className = 'sheet-topline';
        titleWrap.className = 'sheet-title-wrap';
        kicker.className = 'sheet-kicker';
        title.className = 'sheet-title';
        summary.className = 'sheet-summary';
        sourceIndicator.className = 'sheet-source-indicator';
        toolbar.className = 'sheet-toolbar';
        formulaSection.className = 'sheet-formula';
        formulaHeader.className = 'sheet-formula-header';
        formulaLabel.className = 'sheet-formula-label';
        saveStatus.className = 'sheet-save-status';
        formulaInput.className = 'sheet-formula-input';
        gridShell.className = 'sheet-grid-shell';
        gridScroll.className = 'sheet-grid-scroll';

        kicker.textContent = 'Spreadsheet Workspace';
        formulaInput.type = 'text';
        formulaInput.spellcheck = false;

        toolbar.appendChild(createButton('Add Row', 'sheet-button', () => insertRow(state.selectedRow)));
        toolbar.appendChild(createButton('Add Column', 'sheet-button', () => insertColumn(state.selectedCol)));
        toolbar.appendChild(createButton('Delete Row', 'sheet-danger-button', deleteSelectedRow));
        toolbar.appendChild(createButton('Delete Column', 'sheet-danger-button', deleteSelectedColumn));
        toolbar.appendChild(createButton('Reset Local Edits', 'sheet-danger-button', resetToOriginalSheet));
        toolbar.appendChild(createButton('Download Sheet', 'sheet-button', downloadCurrentSheet));

        formulaInput.addEventListener('input', handleFormulaInput);
        formulaInput.addEventListener('keydown', handleFormulaKeyDown);
        grid.addEventListener('click', handleGridClick);
        grid.addEventListener('dblclick', handleGridDoubleClick);
        document.addEventListener('keydown', handleKeyboardNavigation);
        document.addEventListener('paste', handlePaste);

        titleWrap.append(kicker, title, summary);
        topLine.append(titleWrap, sourceIndicator);
        topbar.append(topLine, toolbar);
        formulaHeader.append(formulaLabel, saveStatus);
        formulaSection.append(formulaHeader, formulaInput);
        gridScroll.appendChild(grid);
        gridShell.appendChild(gridScroll);
        app.append(topbar, formulaSection, gridShell);

        state.root = app;
        state.titleNode = title;
        state.summaryNode = summary;
        state.formulaLabelNode = formulaLabel;
        state.formulaInputNode = formulaInput;
        state.gridNode = grid;
        state.saveStatusNode = saveStatus;
        state.sourceIndicatorNode = sourceIndicator;
    }

    function registerMenuCommands() {
        GM_registerMenuCommand('Download Current Sheet', downloadCurrentSheet);
        GM_registerMenuCommand('Reset Local Edits', resetToOriginalSheet);
        GM_registerMenuCommand('Add Row After Selection', () => insertRow(state.selectedRow));
        GM_registerMenuCommand('Add Column After Selection', () => insertColumn(state.selectedCol));
    }

    function initializeSheetState() {
        const sourceText = getRawDocumentText();
        const fileName = getFileNameFromLocation();
        const extension = getExtensionFromFileName(fileName);
        const delimiter = detectDelimiter(sourceText, extension);
        const parsedRows = parseDelimitedText(sourceText, delimiter);

        state.delimiter = delimiter;
        state.rows = parsedRows;
        state.originalRows = cloneRows(parsedRows);
        state.originalFileName = fileName;
        state.fileExtension = delimiter === '\t' ? 'tsv' : 'csv';
        state.sheetName = fileName.replace(/\.[^.]+$/, '') || 'sheet';

        loadPersistedSheet();
        clampSelection();
    }

    function initializeViewer() {
        applyBaseStyles();
        initializeSheetState();
        buildAppShell();
        document.title = `${state.sheetName} - Spreadsheet Viewer`;
        document.body.replaceChildren(state.root);
        registerMenuCommands();
        renderGrid();
        focusSelectedCell();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initializeViewer();
    } else {
        document.addEventListener('DOMContentLoaded', initializeViewer);
    }
})();
