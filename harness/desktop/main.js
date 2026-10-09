'use strict'
// Forge Harness desktop app: starts the engine in-process on a private
// localhost port and shows the web GUI in a native window.
const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

const dist = path.join(__dirname, '..', 'dist')
const { createServer, listen } = require(path.join(dist, 'server', 'server.js'))
const { Store } = require(path.join(dist, 'core', 'store.js'))

let mainWindow = null
let engineUrl = ''

async function startEngine() {
  const server = createServer({ store: new Store(), webDir: path.join(__dirname, '..', 'web') })
  const port = await listen(server, 0, '127.0.0.1')
  engineUrl = `http://127.0.0.1:${port}`
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 420,
    minHeight: 500,
    title: 'Forge Harness',
    icon: path.join(__dirname, '..', 'web', 'icon.svg'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  mainWindow.removeMenu()
  // Links in agent replies open in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(engineUrl)) event.preventDefault()
  })
  mainWindow.loadURL(engineUrl)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(async () => {
    await startEngine()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
