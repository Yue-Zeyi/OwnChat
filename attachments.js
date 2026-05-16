(function () {
  'use strict';

  const TEXT_FILE_INLINE_MAX_BYTES = 1024 * 1024;
  const EXTRACTABLE_FILE_MAX_BYTES = 10 * 1024 * 1024;
  const PDF_TEXT_EXTRACT_MAX_BYTES = 10 * 1024 * 1024;
  const TEXT_FILE_EXTENSIONS = new Set([
    'txt', 'md', 'csv', 'json', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css',
    'xml', 'yaml', 'yml', 'php', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
    'cs', 'rb', 'swift', 'kt', 'kts', 'vue', 'svelte', 'sh', 'bash', 'zsh',
    'sql', 'toml', 'ini', 'env', 'log', 'tsv'
  ]);
  const EXTRACTABLE_FILE_EXTENSIONS = new Set(['docx', 'rtf', 'odt', 'pptx', 'xlsx']);
  const UNSUPPORTED_BINARY_EXTENSIONS = new Set(['doc', 'ppt', 'xls']);
  const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif']);

  function fileExtension(name = '') {
    const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  function isPdfFile(file) {
    return fileExtension(file?.name) === 'pdf' || (file?.type || '').toLowerCase() === 'application/pdf';
  }

  function isImageFile(file) {
    return (file?.type || '').toLowerCase().startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(fileExtension(file?.name));
  }

  function isTextFile(file) {
    if (isImageFile(file)) return false;
    const ext = fileExtension(file?.name);
    if (isPdfFile(file) || EXTRACTABLE_FILE_EXTENSIONS.has(ext) || UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) return false;
    const type = (file?.type || '').toLowerCase();
    if (type.startsWith('text/')) return true;
    if (/json|xml|csv|yaml|markdown|javascript|typescript|x-sh|x-shellscript|x-php|x-python|sql|toml/.test(type)) return true;
    return TEXT_FILE_EXTENSIONS.has(ext);
  }

  function isExtractableFile(file) {
    return EXTRACTABLE_FILE_EXTENSIONS.has(fileExtension(file?.name));
  }

  function unsupportedAttachmentReason(file) {
    if (isImageFile(file)) return '';
    const ext = fileExtension(file?.name);
    if (UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) {
      const target = ext === 'doc' ? 'docx' : (ext === 'ppt' ? 'pptx' : 'xlsx');
      return `${file?.name || '附件'} 是旧版 Office 二进制格式，请转为 ${target} 或 PDF 后上传`;
    }
    if (!isTextFile(file) && !isExtractableFile(file) && !isPdfFile(file)) {
      return `${file?.name || '附件'} 当前不支持，请转为文本、PDF 或新版 Office 文件`;
    }
    return '';
  }

  function maxChatAttachmentBytes(file) {
    if (isImageFile(file)) return null;
    const ext = fileExtension(file?.name);
    if (isTextFile(file)) return TEXT_FILE_INLINE_MAX_BYTES;
    if (EXTRACTABLE_FILE_EXTENSIONS.has(ext)) return EXTRACTABLE_FILE_MAX_BYTES;
    if (isPdfFile(file)) return PDF_TEXT_EXTRACT_MAX_BYTES;
    return 0;
  }

  function storedTextBytes(value) {
    if (value == null) return 0;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return 0;
    if (typeof Blob !== 'undefined') return new Blob([text]).size;
    return new TextEncoder().encode(text).length;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb >= 100 ? 0 : 2)} MB`;
  }

  function validateReadyFiles(files) {
    const unsupported = files.find(f => unsupportedAttachmentReason(f));
    if (unsupported) return [unsupportedAttachmentReason(unsupported)];
    const oversizedText = files.find(f => typeof f.text === 'string' && storedTextBytes(f.text) > TEXT_FILE_INLINE_MAX_BYTES);
    if (oversizedText) return [`${oversizedText.name || '附件'} 超过 ${formatBytes(TEXT_FILE_INLINE_MAX_BYTES)}，无法作为内联文本发送`];
    return [];
  }

  function createPendingEntry(file, name) {
    return { name: name || file?.name || 'attachment', size: file?.size || 0, type: file?.type || '', loading: true };
  }

  function isReady(entry) {
    return !!(entry && !entry.loading && !entry.error && (entry.base64 || typeof entry.text === 'string'));
  }

  function hasError(entry) {
    return !!entry?.error;
  }

  function isLoading(entry) {
    return !!entry?.loading || (!hasError(entry) && !isReady(entry));
  }

  function failEntry(entry, message) {
    entry.loading = false;
    entry.error = true;
    entry.errorText = message || '读取失败';
    return entry;
  }

  async function readIntoEntry(entry, file) {
    const unsupportedReason = unsupportedAttachmentReason(entry);
    if (unsupportedReason) {
      return failEntry(entry, unsupportedReason.replace(`${entry.name} `, ''));
    }
    const maxBytes = maxChatAttachmentBytes(entry);
    if (maxBytes !== null && (file?.size || 0) > maxBytes) {
      return failEntry(entry, `超过 ${formatBytes(maxBytes)}`);
    }
    try {
      Object.assign(entry, await readAttachment(file));
      entry.loading = false;
      delete entry.error;
      delete entry.errorText;
    } catch (err) {
      failEntry(entry, err?.message || '读取失败');
    }
    return entry;
  }

  function fileTextInline(file) {
    if (typeof file?.text === 'string') {
      const source = file.extractionLabel ? ` · ${file.extractionLabel}` : '';
      return `[文件: ${file.name || '附件'}${source}]\n${file.text}`;
    }
    return `[文件: ${file?.name || '附件'}]\n此文件不是文本/代码文件，当前接口无法直接读取正文。`;
  }

  function promptPartsFromReadyFiles(userText, files) {
    const contentParts = [{ type: 'text', text: userText }];
    for (const file of files) {
      if (file.base64) {
        contentParts.push({ type: 'image_url', image_url: { url: file.base64 } });
      } else {
        contentParts.push({ type: 'text', text: fileTextInline(file) });
      }
    }
    return contentParts;
  }

  function metadataFromReadyFiles(files) {
    return files.map(file => ({
      name: file.name,
      type: file.type,
      size: file.size,
      base64: file.base64,
      text: file.text,
      extractionLabel: file.extractionLabel,
    }));
  }

  function messageFromReadyFiles(userText, files, meta = {}) {
    return Object.assign({
      role: 'user',
      content: promptPartsFromReadyFiles(userText, files),
      files: metadataFromReadyFiles(files),
    }, meta);
  }

  function apiMessagesFromPromptMessages(messages) {
    return messages.map(msg => {
      if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
      if (Array.isArray(msg.content)) {
        const content = msg.content.filter(part => part?.type === 'text' || part?.type === 'image_url');
        if (content.every(part => part?.type === 'text')) {
          return { role: msg.role, content: content.map(part => part.text || '').filter(Boolean).join('\n\n') };
        }
        return { role: msg.role, content };
      }
      return { role: msg.role, content: String(msg.content || '') };
    });
  }

  function xmlTextContent(xml) {
    return String(xml || '')
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<w:br\s*\/>|<text:line-break\s*\/>|<a:br\s*\/>/g, '\n')
      .replace(/<\/w:p>|<\/text:p>|<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function rtfToText(rtf) {
    return String(rtf || '')
      .replace(/\\'[0-9a-fA-F]{2}/g, match => String.fromCharCode(parseInt(match.slice(2), 16)))
      .replace(/\\par[d]?|\\line/g, '\n')
      .replace(/\\tab/g, '\t')
      .replace(/\\u(-?\d+)\??/g, (_, code) => String.fromCharCode(Number(code) < 0 ? Number(code) + 65536 : Number(code)))
      .replace(/[{}]/g, '')
      .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
      .replace(/\\[^a-zA-Z\s]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function extractPdfTextWithPdfJs(arrayBuffer) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs?.getDocument) throw new Error('PDF.js 不可用');
    if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    }
    const pdf = await pdfjs.getDocument({ data: arrayBuffer.slice(0) }).promise;
    const pages = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str || '').join(' ').replace(/[ \t]{2,}/g, ' ').trim();
      if (text) pages.push(`## 第 ${pageNo} 页\n${text}`);
    }
    return pages.join('\n\n').trim();
  }

  async function extractDocxTextWithMammoth(arrayBuffer) {
    if (!window.mammoth?.extractRawText) throw new Error('Mammoth 不可用');
    const result = await window.mammoth.extractRawText({ arrayBuffer: arrayBuffer.slice(0) });
    return (result.value || '').trim();
  }

  function extractXlsxTextWithSheetJs(arrayBuffer) {
    if (!window.XLSX?.read) throw new Error('SheetJS 不可用');
    const workbook = window.XLSX.read(arrayBuffer, { type: 'array' });
    return workbook.SheetNames.map(name => {
      const csv = window.XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false }).trim();
      return csv ? `## ${name}\n${csv}` : '';
    }).filter(Boolean).join('\n\n').trim();
  }

  async function readZipEntriesWithJsZip(arrayBuffer, wantedNames) {
    if (!window.JSZip?.loadAsync) throw new Error('JSZip 不可用');
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const entries = new Map();
    for (const name of wantedNames) {
      const item = zip.file(name);
      if (item) entries.set(name, await item.async('string'));
    }
    return entries;
  }

  async function extractZipXmlText(arrayBuffer, wantedNames) {
    return readZipEntriesWithJsZip(arrayBuffer, wantedNames);
  }

  function rowsToCsv(rows) {
    return rows
      .filter(row => row.some(cell => String(cell || '').trim()))
      .map(row => row.map(cell => {
        const value = String(cell || '').replace(/\s+/g, ' ').trim();
        return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      }).join(','))
      .join('\n');
  }

  function columnNameToIndex(name) {
    let index = 0;
    for (const char of name) index = index * 26 + char.charCodeAt(0) - 64;
    return index - 1;
  }

  function extractXlsxText(entries) {
    const sharedXml = entries.get('xl/sharedStrings.xml') || '';
    const sharedStrings = Array.from(sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/g)).map(match => xmlTextContent(match[0]));
    const sheetRows = [];
    for (const [name, xml] of entries) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
      const rows = [];
      for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
        const row = [];
        for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = cellMatch[1];
          const body = cellMatch[2];
          const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
          const col = ref ? columnNameToIndex(ref) : row.length;
          const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
          let value = '';
          if (type === 'inlineStr') value = xmlTextContent(body);
          else {
            const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
            value = type === 's' ? (sharedStrings[Number(raw)] || '') : raw;
          }
          row[col] = value;
        }
        rows.push(row);
      }
      const csv = rowsToCsv(rows);
      if (csv) sheetRows.push(`## ${name.split('/').pop()}\n${csv}`);
    }
    return sheetRows.join('\n\n').trim();
  }

  async function extractDocumentText(file, arrayBuffer) {
    const ext = fileExtension(file.name);
    if (ext === 'rtf') return { text: rtfToText(new TextDecoder().decode(arrayBuffer)), label: 'RTF 提取文本' };
    if (ext === 'pdf') {
      try {
        const text = await extractPdfTextWithPdfJs(arrayBuffer);
        if (text) return { text, label: 'PDF.js 提取文本' };
      } catch (err) {
        throw new Error(err?.message || 'PDF.js 提取失败');
      }
      return { text: '', label: 'PDF.js 提取文本' };
    }

    if (ext === 'docx') {
      try {
        const text = await extractDocxTextWithMammoth(arrayBuffer);
        if (text) return { text, label: 'Mammoth 提取文本' };
      } catch { /* fall back to XML extraction */ }
      const entries = await extractZipXmlText(arrayBuffer, ['word/document.xml']);
      return { text: xmlTextContent(entries.get('word/document.xml')), label: 'DOCX 提取文本' };
    }
    if (ext === 'odt') {
      const entries = await extractZipXmlText(arrayBuffer, ['content.xml']);
      return { text: xmlTextContent(entries.get('content.xml')), label: 'ODT 提取文本' };
    }
    if (ext === 'pptx') {
      const wanted = [];
      for (let i = 1; i <= 120; i++) wanted.push(`ppt/slides/slide${i}.xml`);
      const entries = await extractZipXmlText(arrayBuffer, wanted);
      const slides = [];
      for (const [name, xml] of entries) {
        const text = xmlTextContent(xml);
        if (text) slides.push(`## ${name.split('/').pop()}\n${text}`);
      }
      return { text: slides.join('\n\n'), label: 'PPTX 提取文本' };
    }
    if (ext === 'xlsx') {
      try {
        const text = extractXlsxTextWithSheetJs(arrayBuffer);
        if (text) return { text, label: 'SheetJS 提取表格' };
      } catch { /* fall back to XML extraction */ }
      const wanted = ['xl/sharedStrings.xml'];
      for (let i = 1; i <= 80; i++) wanted.push(`xl/worksheets/sheet${i}.xml`);
      const entries = await extractZipXmlText(arrayBuffer, wanted);
      return { text: extractXlsxText(entries), label: 'XLSX 提取文本' };
    }
    return { text: '', label: '' };
  }

  async function readAttachment(file) {
    const readAsDataUrl = () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const readAsText = () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
    const readAsArrayBuffer = () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });

    if (isImageFile(file)) {
      return { base64: await readAsDataUrl() };
    }
    if (isTextFile(file)) {
      return { text: await readAsText(), extractionLabel: '文本文件' };
    }
    if (isExtractableFile(file) || isPdfFile(file)) {
      const extracted = await extractDocumentText(file, await readAsArrayBuffer());
      if (!extracted.text.trim()) {
        throw new Error(isPdfFile(file) ? '未提取到文本，可能是扫描版 PDF' : '未提取到文本');
      }
      if (storedTextBytes(extracted.text) > TEXT_FILE_INLINE_MAX_BYTES) {
        throw new Error(`提取文本超过 ${formatBytes(TEXT_FILE_INLINE_MAX_BYTES)}`);
      }
      return { text: extracted.text, extractionLabel: extracted.label };
    }
    throw new Error('不支持');
  }

  window.OwnChatAttachments = {
    limits: {
      textInlineMaxBytes: TEXT_FILE_INLINE_MAX_BYTES,
      extractableFileMaxBytes: EXTRACTABLE_FILE_MAX_BYTES,
      pdfTextExtractMaxBytes: PDF_TEXT_EXTRACT_MAX_BYTES,
    },
    isTextFile,
    createPendingEntry,
    isReady,
    hasError,
    isLoading,
    storedTextBytes,
    formatBytes,
    readIntoEntry,
    validateReadyFiles,
    fileTextInline,
    messageFromReadyFiles,
    apiMessagesFromPromptMessages,
  };
})();
