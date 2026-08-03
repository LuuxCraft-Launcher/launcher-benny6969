/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, ipcMain, nativeTheme, session } = require('electron');
const { Microsoft } = require('minecraft-java-core');
const { autoUpdater } = require('electron-updater')

const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const UpdateWindow = require("./assets/js/windows/updateWindow.js");
const MainWindow = require("./assets/js/windows/mainWindow.js");

let dev = process.env.NODE_ENV === 'dev';

app.commandLine.appendSwitch('disable-http-cache');

function configureNoCacheSession() {
    const defaultSession = session.defaultSession;

    defaultSession.clearCache().catch(() => {});

    defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        details.requestHeaders['Pragma'] = 'no-cache';
        callback({ requestHeaders: details.requestHeaders });
    });

    defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = { ...details.responseHeaders };
        responseHeaders['Cache-Control'] = ['no-store, no-cache, must-revalidate, max-age=0'];
        responseHeaders['Pragma'] = ['no-cache'];
        responseHeaders['Expires'] = ['0'];
        callback({ responseHeaders });
    });
}

if (dev) {
    let appPath = path.resolve('./data/Launcher').replace(/\\/g, '/');
    let appdata = path.resolve('./data').replace(/\\/g, '/');
    if (!fs.existsSync(appPath)) fs.mkdirSync(appPath, { recursive: true });
    if (!fs.existsSync(appdata)) fs.mkdirSync(appdata, { recursive: true });
    app.setPath('userData', appPath);
    app.setPath('appData', appdata)
}

Store.initRenderer();

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
    configureNoCacheSession();
    if (dev) return MainWindow.createWindow()
    UpdateWindow.createWindow()
});

ipcMain.on('main-window-open', () => MainWindow.createWindow())
ipcMain.on('main-window-dev-tools', () => MainWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('main-window-dev-tools-close', () => MainWindow.getWindow().webContents.closeDevTools())
ipcMain.on('main-window-close', () => MainWindow.destroyWindow())
ipcMain.on('main-window-reload', () => MainWindow.getWindow().reload())
ipcMain.on('main-window-progress', (event, options) => MainWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('main-window-progress-reset', () => MainWindow.getWindow().setProgressBar(-1))
ipcMain.on('main-window-progress-load', () => MainWindow.getWindow().setProgressBar(2))
ipcMain.on('main-window-minimize', () => MainWindow.getWindow().minimize())

ipcMain.on('update-window-close', () => UpdateWindow.destroyWindow())
ipcMain.on('update-window-dev-tools', () => UpdateWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('update-window-progress', (event, options) => UpdateWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('update-window-progress-reset', () => UpdateWindow.getWindow().setProgressBar(-1))
ipcMain.on('update-window-progress-load', () => UpdateWindow.getWindow().setProgressBar(2))

ipcMain.handle('path-user-data', () => app.getPath('userData'))
ipcMain.handle('appData', e => app.getPath('appData'))

ipcMain.on('main-window-maximize', () => {
    if (MainWindow.getWindow().isMaximized()) {
        MainWindow.getWindow().unmaximize();
    } else {
        MainWindow.getWindow().maximize();
    }
})

ipcMain.on('main-window-hide', () => MainWindow.getWindow().hide())
ipcMain.on('main-window-show', () => MainWindow.getWindow().show())

ipcMain.handle('Microsoft-window', async (_, client_id) => {
    return await new Microsoft(client_id).getAuth();
})

ipcMain.handle('is-dark-theme', (_, theme) => {
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return nativeTheme.shouldUseDarkColors;
})

app.on('window-all-closed', () => app.quit());

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

ipcMain.handle('update-app', async () => {
    try {
        const result = await autoUpdater.checkForUpdates();
        if (!result) return null;
        return {
            updateAvailable: !!result.updateInfo,
            version: result.updateInfo?.version || null,
        };
    } catch (error) {
        throw new Error(error?.message || 'Impossible de verifier les mises a jour.');
    }
})

autoUpdater.on('update-available', (info) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('updateAvailable', info);
});

ipcMain.on('start-update', () => {
    autoUpdater.downloadUpdate();
})

autoUpdater.on('update-not-available', () => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('update-not-available');
});

autoUpdater.on('update-downloaded', () => {
    autoUpdater.quitAndInstall(true, true);
});

autoUpdater.on('download-progress', (progress) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('download-progress', progress);
})

autoUpdater.on('error', (err) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) {
        updateWindow.webContents.send('error', {
            code: 'AUTO_UPDATER_ERROR',
            message: err?.message || 'Une erreur est survenue pendant la mise a jour.'
        });
    }
});