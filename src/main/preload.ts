import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { ipcErrorReason } from '../shared/display-text';
contextBridge.exposeInMainWorld('airoom', {
  invoke: (method: string, params?: unknown) => ipcRenderer.invoke('airoom:invoke', method, params).catch(error => { throw new Error(ipcErrorReason(error)); }),
  /** Local path of a file dropped onto the window (Electron no longer exposes File.path). */
  pathForFile: (file: File) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, value: unknown) => callback(value);
    ipcRenderer.on('airoom:event', listener);
    return () => ipcRenderer.removeListener('airoom:event', listener);
  },
});
