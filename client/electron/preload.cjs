const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('jiandanDesktop', {
  platform: process.platform,
})
