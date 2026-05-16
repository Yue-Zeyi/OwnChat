(function () {
  'use strict';

  const IMAGE_DB = { name: 'ownchat_image_db', version: 3, store: 'jobs', fileStore: 'files' };
  const STREAM_KEY = 'active_stream';
  const IMAGE_KEY = 'active_image';
  const STREAM_DB_NAME = 'ownchat_stream_db';
  const STREAM_DB_VERSION = 2;
  const STREAM_STORE = 'sessions';

  let imageDbPromise = null;
  let imageDbWarned = false;
  let imageSaveErrorHandler = null;
  let streamDbPromise = null;

  function setImageSaveErrorHandler(handler) {
    imageSaveErrorHandler = typeof handler === 'function' ? handler : null;
  }

  function idbRequest(req, fallback = null) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result ?? fallback);
      req.onerror = () => reject(req.error);
    });
  }

  function idbTxDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function openImageDb() {
    if (imageDbPromise) return imageDbPromise;
    imageDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(IMAGE_DB.name, IMAGE_DB.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IMAGE_DB.store)) {
          const store = db.createObjectStore(IMAGE_DB.store, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(IMAGE_DB.fileStore)) {
          db.createObjectStore(IMAGE_DB.fileStore, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return imageDbPromise;
  }

  async function imageDbGetAllJobs() {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.store, 'readonly');
      const jobs = await idbRequest(tx.objectStore(IMAGE_DB.store).getAll(), []);
      return jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (error) {
      console.warn('Image history load failed:', error);
      return [];
    }
  }

  async function imageDbPutJob(job) {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.store, 'readwrite');
      tx.objectStore(IMAGE_DB.store).put(job);
      await idbTxDone(tx);
    } catch (error) {
      console.warn('Image history save failed:', error);
      if (!imageDbWarned) {
        imageDbWarned = true;
        if (imageSaveErrorHandler) imageSaveErrorHandler(error);
      }
    }
  }

  async function imageDbDeleteJob(id) {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.store, 'readwrite');
      tx.objectStore(IMAGE_DB.store).delete(id);
      await idbTxDone(tx);
    } catch (error) {
      console.warn('Image history delete failed:', error);
    }
  }

  async function imageDbClearJobs() {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.store, 'readwrite');
      tx.objectStore(IMAGE_DB.store).clear();
      await idbTxDone(tx);
    } catch (error) {
      console.warn('Image history clear failed:', error);
    }
  }

  async function fileDbPut(attachmentRecord) {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.fileStore, 'readwrite');
      tx.objectStore(IMAGE_DB.fileStore).put(attachmentRecord);
      await idbTxDone(tx);
      return true;
    } catch (error) {
      console.warn('File attachment save failed:', error);
      return false;
    }
  }

  async function fileDbGetAll() {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.fileStore, 'readonly');
      return await idbRequest(tx.objectStore(IMAGE_DB.fileStore).getAll(), []);
    } catch (error) {
      console.warn('File attachments load failed:', error);
      return [];
    }
  }

  async function fileDbDelete(id) {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.fileStore, 'readwrite');
      tx.objectStore(IMAGE_DB.fileStore).delete(id);
      await idbTxDone(tx);
    } catch (error) {
      console.warn('File attachment delete failed:', error);
    }
  }

  async function fileDbClearAll() {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.fileStore, 'readwrite');
      tx.objectStore(IMAGE_DB.fileStore).clear();
      await idbTxDone(tx);
    } catch (error) {
      console.warn('File attachments clear failed:', error);
    }
  }

  function openStreamDb() {
    if (streamDbPromise) return streamDbPromise;
    streamDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(STREAM_DB_NAME, STREAM_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STREAM_STORE)) {
          db.createObjectStore(STREAM_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return streamDbPromise;
  }

  async function writeStreamSession(meta) {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).put(Object.assign({ id: STREAM_KEY, assistantContent: '', reasoningContent: '', status: 'streaming', updatedAt: Date.now() }, meta));
      await idbTxDone(tx);
    } catch {
      /* ignore */
    }
  }

  async function getStreamSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readonly');
      return await idbRequest(tx.objectStore(STREAM_STORE).get(STREAM_KEY), null);
    } catch {
      return null;
    }
  }

  async function getStableStreamSession(baseSession) {
    if (!baseSession || !['complete', 'error', 'stopped'].includes(baseSession.status)) return baseSession;
    await new Promise(resolve => setTimeout(resolve, 50));
    const latest = await getStreamSession();
    if (!latest || (latest.convId && baseSession.convId && latest.convId !== baseSession.convId)) return baseSession;
    return Object.assign({}, baseSession, latest);
  }

  async function clearStreamSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).delete(STREAM_KEY);
      await idbTxDone(tx);
    } catch {
      /* ignore */
    }
  }

  async function getImageSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readonly');
      return normalizeImageSession(await idbRequest(tx.objectStore(STREAM_STORE).get(IMAGE_KEY), null));
    } catch {
      return null;
    }
  }

  function normalizeImageSession(session) {
    if (!session) return null;
    if ((session.status === 'connecting' || session.status === 'streaming')) {
      if (typeof session.outputs === 'string' && session.outputs.trim()) {
        return Object.assign({}, session, { status: 'complete' });
      }
      if (session.error) {
        return Object.assign({}, session, { status: 'error' });
      }
    }
    return session;
  }

  function parseImageSessionOutputs(session) {
    try {
      const raw = session?.outputs;
      if (Array.isArray(raw)) return raw;
      if (typeof raw !== 'string' || !raw.trim()) return [];
      const outputs = JSON.parse(raw);
      return Array.isArray(outputs) ? outputs : [];
    } catch {
      return [];
    }
  }

  async function clearImageSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).delete(IMAGE_KEY);
      await idbTxDone(tx);
    } catch {
      /* ignore */
    }
  }

  async function clearImageSessionForJob(jobId, statuses = []) {
    try {
      const session = await getImageSession();
      if (!session || session.jobId !== jobId) return;
      if (statuses.length && !statuses.includes(session.status)) return;
      await clearImageSession();
    } catch {
      /* ignore */
    }
  }

  async function writeImageSession(meta) {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).put(Object.assign({ id: IMAGE_KEY, status: 'stopped', updatedAt: Date.now() }, meta));
      await idbTxDone(tx);
    } catch {
      /* ignore */
    }
  }

  function collectConversationFileIds(conversations) {
    const ids = new Set();
    for (const conv of conversations || []) {
      if (!conv) continue;
      for (const msg of conv.messages || []) {
        if (Array.isArray(msg.files)) {
          msg.files.forEach(file => {
            if (file?.fileId) ids.add(file.fileId);
          });
        }
        if (Array.isArray(msg.content)) {
          msg.content.forEach(part => {
            const fileId = part?.type === 'image_url' ? part.image_url?.fileId : null;
            if (fileId) ids.add(fileId);
          });
        }
      }
    }
    return Array.from(ids);
  }

  function collectDeletedOnlyFileIds(deletedConversations, remainingConversations) {
    const deletedIds = new Set(collectConversationFileIds(deletedConversations));
    const remainingIds = new Set(collectConversationFileIds(remainingConversations));
    return Array.from(deletedIds).filter(id => !remainingIds.has(id));
  }

  function generateFileId(convId, msgIndex, partIndex) {
    return `${convId}_${msgIndex}_${partIndex}`;
  }

  function stripFilesFromConversations(conversations) {
    const Attachments = window.OwnChatAttachments;
    const fileMap = [];
    const queuedFileIds = new Set();
    const queueFile = attachmentRecord => {
      if (!attachmentRecord?.id || queuedFileIds.has(attachmentRecord.id)) return;
      queuedFileIds.add(attachmentRecord.id);
      fileMap.push(attachmentRecord);
    };
    const stripped = conversations.map(conv => {
      const strippedConv = Object.assign({}, conv);
      strippedConv.messages = conv.messages.map((msg, msgIdx) => {
        const imageFileIds = [];
        const textFileRefs = [];
        let changed = false;
        const strippedMsg = Object.assign({}, msg);
        if (msg.files && msg.files.length) {
          strippedMsg.files = msg.files.map((file, fileIdx) => {
            const fileId = file.fileId || generateFileId(conv.id, msgIdx, fileIdx);
            if (file.base64) {
              queueFile({ id: fileId, base64: file.base64, name: file.name, type: file.type, size: file.size });
              imageFileIds.push(fileId);
              changed = true;
              return { name: file.name, type: file.type, size: file.size, fileId };
            }
            if (typeof file.text === 'string') {
              const ref = { fileId, name: file.name, type: file.type, size: file.size, text: file.text, extractionLabel: file.extractionLabel };
              queueFile({ id: fileId, text: file.text, extractionLabel: file.extractionLabel, name: file.name, type: file.type, size: file.size });
              textFileRefs.push(ref);
              changed = true;
              return { name: file.name, type: file.type, size: file.size, fileId, extractionLabel: file.extractionLabel };
            }
            if (file.fileId) {
              if ((file.type || '').startsWith('image/')) imageFileIds.push(file.fileId);
              else textFileRefs.push({ fileId: file.fileId, name: file.name, type: file.type, size: file.size, text: file.text, extractionLabel: file.extractionLabel });
            }
            return file;
          });
        }
        if (Array.isArray(msg.content)) {
          let imageIdx = 0;
          let textIdx = 0;
          strippedMsg.content = msg.content.map((part, partIdx) => {
            if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
              const fileId = part.image_url.fileId || imageFileIds[imageIdx] || generateFileId(conv.id, msgIdx, partIdx);
              imageIdx += 1;
              queueFile({ id: fileId, base64: part.image_url.url, name: '', type: 'image_url' });
              changed = true;
              return Object.assign({}, part, { image_url: { url: fileId, fileId } });
            }
            if (part.type === 'image_url' && part.image_url?.fileId) imageIdx += 1;
            if (part.type === 'text' && partIdx > 0 && textIdx < textFileRefs.length) {
              const ref = textFileRefs[textIdx];
              const expectedText = typeof ref.text === 'string' && Attachments?.fileTextInline ? Attachments.fileTextInline(ref) : '';
              if (expectedText && part.text === expectedText) {
                textIdx += 1;
                changed = true;
                return {
                  type: 'text',
                  text: `[文件: ${ref.name || '附件'}]\n附件文本已移至本地索引，加载后会自动恢复。`,
                  attachmentFileId: ref.fileId,
                };
              }
            }
            return part;
          });
        }
        return changed ? strippedMsg : msg;
      });
      return strippedConv;
    });
    return { stripped, fileMap };
  }

  async function hydrateFilesInConversations(conversations) {
    const Attachments = window.OwnChatAttachments;
    const allFiles = await fileDbGetAll();
    const fileById = new Map(allFiles.map(file => [file.id, file]));
    for (const conv of conversations) {
      for (const msg of conv.messages) {
        if (msg.files && msg.files.length) {
          for (const file of msg.files) {
            if (file.fileId) {
              const stored = fileById.get(file.fileId);
              if (stored) {
                if (stored.base64) file.base64 = stored.base64;
                if (stored.text && !file.text) file.text = stored.text;
                if (stored.extractionLabel && !file.extractionLabel) file.extractionLabel = stored.extractionLabel;
                delete file.missing;
              } else {
                file.missing = true;
              }
            }
          }
        }
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'image_url' && part.image_url?.fileId) {
              const stored = fileById.get(part.image_url.fileId);
              if (stored) {
                part.image_url.url = stored.base64;
                delete part.image_url.missing;
              } else {
                part.image_url.missing = true;
              }
            }
            if (part.type === 'text' && part.attachmentFileId) {
              const stored = fileById.get(part.attachmentFileId);
              if (stored?.text && Attachments?.fileTextInline) {
                part.text = Attachments.fileTextInline(stored);
                delete part.missing;
              } else {
                part.missing = true;
              }
            }
          }
        }
      }
    }
    return conversations;
  }

  window.OwnChatDb = {
    IMAGE_KEY,
    setImageSaveErrorHandler,
    imageDbGetAllJobs,
    imageDbPutJob,
    imageDbDeleteJob,
    imageDbClearJobs,
    fileDbPut,
    fileDbGetAll,
    fileDbDelete,
    fileDbClearAll,
    writeStreamSession,
    getStreamSession,
    getStableStreamSession,
    clearStreamSession,
    getImageSession,
    normalizeImageSession,
    parseImageSessionOutputs,
    clearImageSession,
    clearImageSessionForJob,
    writeImageSession,
    collectConversationFileIds,
    collectDeletedOnlyFileIds,
    stripFilesFromConversations,
    hydrateFilesInConversations,
  };
})();
